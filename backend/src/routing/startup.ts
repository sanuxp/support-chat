import { pool } from "../db/db.js";
import { getHandoff } from "../matrix/rooms.js";
import { toolOptions } from "../tools/registry.js";
import { processQueue } from "./agents.js";
import { armFallback } from "./handoff.js";

/** After a restart: re-arm fallback timers for conversations still waiting, then re-check the queue. */
export async function resumeWaiting(): Promise<void> {
  const rows = (await pool.query("SELECT room_id FROM conversations WHERE status='waiting' AND deleted_at IS NULL")).rows;
  await Promise.all(rows.map(async (row) => {
    const h = await getHandoff(row.room_id).catch(() => null);
    if (!h || h.status !== "waiting") return;
    const opts = toolOptions(h.channel) ?? {};
    const total = Number(opts.fallback_after_seconds ?? 300);
    const remaining = Math.max(0, total - (Date.now() - h.updated_at) / 1000);
    armFallback(row.room_id, remaining, typeof opts.fallback_tool === "string" ? opts.fallback_tool : undefined);
  }));
  await processQueue();
}
