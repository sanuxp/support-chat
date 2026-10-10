import type { FastifyRequest } from "fastify";
import { pool } from "../db/db.js";
import { httpError } from "../api/customer.js";
import { sendMessage } from "../matrix/messages.js";
import { getHandoff, inviteUser, kickUser } from "../matrix/rooms.js";
import { enc, MatrixHttpError, synapse } from "../matrix/synapse.js";
import { updateHandoff } from "./handoff.js";

export const INTERNAL_FLAG = "com.supportchat.internal";
const PRESENCE_TTL_SECONDS = 90; // UI heartbeats every ~30s; stale agents are treated as offline

// --- authentication: agent's own Matrix access token, verified through /account/whoami -----------

const whoamiCache = new Map<string, { userId: string; exp: number }>();

export async function authenticateAgent(req: FastifyRequest): Promise<{ userId: string }> {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Bearer ")) throw httpError(401, "Missing token");
  const token = h.slice(7);
  let hit = whoamiCache.get(token);
  if (!hit || hit.exp < Date.now()) {
    try {
      const r = await synapse<{ user_id: string }>("GET", "/_matrix/client/v3/account/whoami", { token });
      hit = { userId: r.user_id, exp: Date.now() + 30_000 };
      whoamiCache.set(token, hit);
    } catch (e) {
      if (e instanceof MatrixHttpError && (e.status === 401 || e.status === 403)) throw httpError(401, "Invalid token");
      throw e;
    }
  }
  if (!hit.userId.startsWith("@agent_")) throw httpError(403, "Not a support agent account");
  await upsertAgent(hit.userId);
  return { userId: hit.userId };
}

async function upsertAgent(userId: string): Promise<void> {
  const known = await pool.query("SELECT 1 FROM agents WHERE matrix_user_id=$1", [userId]);
  if (known.rowCount) return;
  let name = userId.slice(1).split(":")[0];
  try {
    const p = await synapse<{ displayname?: string }>("GET", `/_matrix/client/v3/profile/${enc(userId)}`);
    if (p.displayname) name = p.displayname;
  } catch { /* keep default */ }
  await pool.query(
    "INSERT INTO agents (matrix_user_id, display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [userId, name],
  );
}

// --- presence + selection ------------------------------------------------------------------------

export async function setPresence(userId: string, online: boolean): Promise<void> {
  await pool.query("UPDATE agents SET online=$2, last_seen=now() WHERE matrix_user_id=$1", [userId, online]);
  if (online) void processQueue();
}

/** Online (fresh heartbeat), below max_concurrent, fewest active conversations first. */
export async function pickAgent(): Promise<string | null> {
  const r = await pool.query(
    `SELECT matrix_user_id FROM (
       SELECT a.matrix_user_id, a.max_concurrent, a.last_seen,
              (SELECT count(*) FROM conversations c
                WHERE c.assigned_agent=a.matrix_user_id AND c.status='assigned' AND c.deleted_at IS NULL) AS active
         FROM agents a
        WHERE a.online AND a.last_seen > now() - make_interval(secs => $1)
     ) s
     WHERE active < max_concurrent
     ORDER BY active ASC, last_seen DESC
     LIMIT 1`,
    [PRESENCE_TTL_SECONDS],
  );
  return (r.rows[0]?.matrix_user_id as string | undefined) ?? null;
}

export async function agentCanTakeMore(userId: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT a.max_concurrent,
            (SELECT count(*) FROM conversations c WHERE c.assigned_agent=a.matrix_user_id AND c.status='assigned' AND c.deleted_at IS NULL) AS active
       FROM agents a WHERE a.matrix_user_id=$1`,
    [userId],
  );
  return !!r.rows[0] && Number(r.rows[0].active) < r.rows[0].max_concurrent;
}

// --- assignment ----------------------------------------------------------------------------------

export async function ensureInvited(roomId: string, agentId: string): Promise<void> {
  try {
    await inviteUser(roomId, agentId);
  } catch (e) {
    // already invited / already joined is fine
    if (!(e instanceof MatrixHttpError && e.status === 403)) throw e;
  }
}

// All assignment goes through one lock and re-checks that the conversation is still 'waiting',
// so the escalation tool, the presence heartbeat and queue processing can't assign the same room twice
// (which would also post the summary twice).
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

/** Invite the agent, mark the conversation assigned, post the (agent-only) AI summary. Caller holds the lock. */
async function assignLocked(roomId: string, agentId: string): Promise<boolean> {
  const before = await getHandoff(roomId);
  if (before.status !== "waiting") return false; // someone else already handled it
  await ensureInvited(roomId, agentId);
  await updateHandoff(roomId, { status: "assigned", agent_id: agentId });
  const bits = [before.summary && `Summary: ${before.summary}`, before.reason && `Reason: ${before.reason}`].filter(Boolean);
  if (bits.length) await sendMessage(roomId, bits.join("\n"), "m.notice", { [INTERNAL_FLAG]: true });
  return true;
}

/** Assign a waiting conversation to the best available agent. Returns the agent, or null if none/not waiting. */
export function assignToBestAgent(roomId: string): Promise<string | null> {
  return exclusive(async () => {
    const agent = await pickAgent();
    if (!agent) return null;
    return (await assignLocked(roomId, agent)) ? agent : null;
  });
}

/** An agent takes a specific waiting conversation (respects max_concurrent). */
export function assignToAgent(roomId: string, agentId: string): Promise<"assigned" | "full" | "unavailable"> {
  return exclusive(async () => {
    if (!(await agentCanTakeMore(agentId))) return "full";
    return (await assignLocked(roomId, agentId)) ? "assigned" : "unavailable";
  });
}

/** Re-check the waiting queue (oldest first). */
export function processQueue(): Promise<void> {
  return exclusive(async () => {
    const waiting = await pool.query(
      "SELECT room_id FROM conversations WHERE status='waiting' AND deleted_at IS NULL ORDER BY updated_at ASC",
    );
    for (const row of waiting.rows) {
      const agent = await pickAgent();
      if (!agent) break;
      try { await assignLocked(row.room_id, agent); }
      catch (e: any) { console.log(JSON.stringify({ msg: "assign failed", roomId: row.room_id, error: e?.message })); }
    }
  }).catch(() => {});
}

export async function resolveConversation(roomId: string, agentId: string, returnToAi: boolean): Promise<void> {
  await kickUser(roomId, agentId, "Conversation resolved").catch(() => {});
  if (returnToAi) {
    await updateHandoff(roomId, { status: "ai", agent_id: null, channel: null, reason: null, summary: null, ai_note: null });
    await sendMessage(roomId, "You're chatting with our AI assistant again.", "m.notice");
  } else {
    await updateHandoff(roomId, { status: "closed", agent_id: null });
    await sendMessage(roomId, "This conversation has ended.", "m.notice");
  }
  void processQueue();
}

