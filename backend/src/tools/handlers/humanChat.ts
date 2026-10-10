import { assignToBestAgent } from "../../routing/agents.js";
import { armFallback } from "../../routing/handoff.js";
import type { ToolHandler } from "../types.js";

/** Hand the conversation to a live agent in this same room (queue + fallback timer). */
const humanChat: ToolHandler = {
  async execute(args, ctx) {
    const current = await ctx.handoff.get();
    if (current.status === "waiting" || current.status === "assigned") {
      // already escalated: don't repeat the customer message
      return { ok: true, llmResult: { status: current.status, note: "already escalated" }, customerMessage: "" };
    }

    await ctx.handoff.set({
      status: "waiting",
      channel: ctx.toolName,
      reason: String(args.reason ?? ""),
      summary: String(args.summary ?? ""),
      ai_note: null,
    });

    const agent = await assignToBestAgent(ctx.roomId);
    if (agent) {
      ctx.log.info("conversation assigned", { agent });
      return { ok: true, llmResult: { status: "assigned" } };
    }
    // another path (e.g. queue processing) may have assigned it in the meantime
    if ((await ctx.handoff.get()).status === "assigned") return { ok: true, llmResult: { status: "assigned" } };

    const fallbackTool = typeof ctx.options.fallback_tool === "string" ? ctx.options.fallback_tool : undefined;
    const seconds = Number(ctx.options.fallback_after_seconds ?? 300);
    armFallback(ctx.roomId, seconds, fallbackTool);
    ctx.log.info("conversation queued", { fallbackAfterSeconds: seconds });
    return { ok: true, llmResult: { status: "waiting", note: "No agent is free yet; the customer is in the queue." } };
  },
};

export default humanChat;
