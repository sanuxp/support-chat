import type { FastifyInstance } from "fastify";
import { pool } from "../db/db.js";
import { getHandoff } from "../matrix/rooms.js";
import {
  assignToAgent, authenticateAgent, ensureInvited, resolveConversation, setPresence,
} from "../routing/agents.js";
import { httpError } from "./customer.js";

async function findConversation(roomId: string) {
  const r = await pool.query(
    "SELECT room_id, status, assigned_agent FROM conversations WHERE room_id=$1 AND deleted_at IS NULL", [roomId],
  );
  if (!r.rows[0]) throw httpError(404, "Conversation not found");
  return r.rows[0] as { room_id: string; status: string; assigned_agent: string | null };
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/agent/presence", async (req) => {
    const { userId } = await authenticateAgent(req);
    const { online } = (req.body ?? {}) as { online?: boolean };
    if (typeof online !== "boolean") throw httpError(400, "online (boolean) required");
    await setPresence(userId, online);
    return { online };
  });

  app.get("/api/agent/conversations", async (req) => {
    const { userId } = await authenticateAgent(req);
    const rows = (
      await pool.query(
        `SELECT room_id, status, assigned_agent, updated_at FROM conversations
          WHERE deleted_at IS NULL AND (status='waiting' OR (status='assigned' AND assigned_agent=$1))
          ORDER BY updated_at ASC`,
        [userId],
      )
    ).rows;
    const out = await Promise.all(rows.map(async (r) => {
      const h = await getHandoff(r.room_id).catch(() => null);
      return {
        roomId: r.room_id, status: r.status, assignedAgent: r.assigned_agent,
        reason: h?.reason ?? null, summary: h?.summary ?? null, updatedAt: r.updated_at,
      };
    }));
    return { conversations: out };
  });

  app.post<{ Params: { roomId: string } }>("/api/agent/conversations/:roomId/accept", async (req) => {
    const { userId } = await authenticateAgent(req);
    const conv = await findConversation(req.params.roomId);
    if (conv.status === "assigned" && conv.assigned_agent === userId) {
      await ensureInvited(conv.room_id, userId); // re-invite if the agent isn't in the room yet
      return { status: "assigned" };
    }
    if (conv.status === "waiting") {
      const r = await assignToAgent(conv.room_id, userId);
      if (r === "full") throw httpError(409, "At your concurrent conversation limit");
      if (r === "unavailable") {
        // lost a race: it may have been assigned to this very agent a moment ago (e.g. by the escalation itself)
        const now = await findConversation(conv.room_id);
        if (now.status === "assigned" && now.assigned_agent === userId) {
          await ensureInvited(conv.room_id, userId);
          return { status: "assigned" };
        }
        throw httpError(409, "Conversation was just taken by someone else");
      }
      return { status: "assigned" };
    }
    throw httpError(403, "Conversation is not available to you");
  });

  app.post<{ Params: { roomId: string } }>("/api/agent/conversations/:roomId/resolve", async (req) => {
    const { userId } = await authenticateAgent(req);
    const conv = await findConversation(req.params.roomId);
    if (conv.status !== "assigned" || conv.assigned_agent !== userId) throw httpError(403, "Not assigned to you");
    const { returnToAi } = (req.body ?? {}) as { returnToAi?: boolean };
    await resolveConversation(conv.room_id, userId, returnToAi !== false);
    return { status: returnToAi !== false ? "ai" : "closed" };
  });
}
