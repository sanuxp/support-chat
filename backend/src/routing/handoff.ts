import { pool } from "../db/db.js";
import { sendMessage } from "../matrix/messages.js";
import { getHandoff, setHandoff, type HandoffState } from "../matrix/rooms.js";

/**
 * The ONE place handoff state changes: updates the Matrix room state (source of truth)
 * and the `conversations` index table together.
 */
export async function updateHandoff(roomId: string, update: Partial<HandoffState>): Promise<HandoffState> {
  const next = await setHandoff(roomId, update);
  await pool.query(
    "UPDATE conversations SET status=$2, assigned_agent=$3, updated_at=now() WHERE room_id=$1",
    [roomId, next.status, next.agent_id],
  );
  if (next.status !== "waiting") clearFallback(roomId);
  return next;
}

// --- waiting -> fallback timeout -------------------------------------------------------------

const timers = new Map<string, NodeJS.Timeout>();

export function clearFallback(roomId: string): void {
  const t = timers.get(roomId);
  if (t) clearTimeout(t);
  timers.delete(roomId);
}

/** If still `waiting` after `seconds`, tell the customer, return to the AI and leave it a note. */
export function armFallback(roomId: string, seconds: number, fallbackTool: string | undefined): void {
  clearFallback(roomId);
  const t = setTimeout(() => {
    timers.delete(roomId);
    void (async () => {
      try {
        const h = await getHandoff(roomId);
        if (h.status !== "waiting") return;
        await updateHandoff(roomId, {
          status: "ai",
          channel: null,
          ai_note: fallbackTool
            ? `No human agent became available for this customer. Apologise briefly and offer the "${fallbackTool}" tool as an alternative. Ask for any details it needs (for example their email address) before calling it; do not call it without them.`
            : "No human agent became available for this customer. Apologise briefly and keep helping as best you can.",
        });
        await sendMessage(
          roomId,
          "Sorry, nobody on our team is available right now.",
          "m.notice",
        );
        console.log(JSON.stringify({ msg: "fallback fired", roomId }));
      } catch (e: any) {
        console.log(JSON.stringify({ msg: "fallback error", roomId, error: e?.message }));
      }
    })();
  }, Math.max(0, seconds) * 1000);
  t.unref?.();
  timers.set(roomId, t);
}
