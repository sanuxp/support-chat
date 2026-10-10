import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { aiUserId } from "../config.js";
import { appservice } from "../matrix/appservice.js";
import { getHistory, sendMessage, setTyping } from "../matrix/messages.js";
import { getHandoff } from "../matrix/rooms.js";
import { updateHandoff } from "../routing/handoff.js";
import { executeTool, getTools, toolAfter } from "../tools/registry.js";
import { streamCompletion } from "./llm.js";
import { buildSystemPrompt } from "./prompt.js";
import { StreamingMessage } from "./streaming.js";

// NOTE (logging rule): never log message bodies, prompts/responses or tool arguments.
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const HISTORY = () => Number(process.env.AI_HISTORY_MESSAGES ?? 30);
const EDIT_MS = () => Number(process.env.AI_STREAM_EDIT_INTERVAL_MS ?? 1000);

// one reply at a time per room, so quick successive messages don't interleave
const queues = new Map<string, Promise<void>>();

export function startAgent(): void {
  appservice.on("room.message", (roomId: string, event: any) => {
    if (event.sender === aiUserId) return;
    if (!String(event.sender).startsWith("@customer_")) return; // only customers trigger the AI
    if (event.content?.msgtype !== "m.text" || typeof event.content?.body !== "string") return; // text only (v1)
    if (event.content?.["m.relates_to"]?.rel_type === "m.replace") return;
    const prev = queues.get(roomId) ?? Promise.resolve();
    const next = prev.then(() => handleCustomerMessage(roomId, event.event_id)).catch(() => {});
    queues.set(roomId, next);
    next.finally(() => { if (queues.get(roomId) === next) queues.delete(roomId); });
  });
  log("ai agent listening");
}

function aiMayReply(h: { status: string; channel: string | null }): boolean {
  if (h.status === "ai") return true;
  // after an external escalation (e.g. email) the AI keeps talking only if that tool says continue_ai
  return h.status === "escalated_external" && toolAfter(h.channel) === "continue_ai";
}

async function handleCustomerMessage(roomId: string, eventId: string): Promise<void> {
  const started = Date.now();
  let typingTimer: NodeJS.Timeout | undefined;
  try {
    let handoff;
    try { handoff = await getHandoff(roomId); } catch { return; } // not a support conversation room
    if (!aiMayReply(handoff)) return;

    typingTimer = setInterval(() => setTyping(roomId, true), 20000);
    const tools = getTools();
    // typing indicator, history and prompt files are independent: do them concurrently
    const [, history, systemPrompt] = await Promise.all([
      setTyping(roomId, true),
      getHistory(roomId, HISTORY()),
      buildSystemPrompt(tools.promptTools),
    ]);
    const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];
    if (handoff.ai_note) messages.push({ role: "system", content: handoff.ai_note });
    for (const m of history) {
      if (m.msgtype === "m.notice") continue; // system notices are not part of the conversation
      if (m.sender === aiUserId) messages.push({ role: "assistant", content: m.body });
      else if (m.sender.startsWith("@customer_")) messages.push({ role: "user", content: m.body });
      else messages.push({ role: "user", content: `[Human agent] ${m.body}` });
    }

    let promptTokens = 0, completionTokens = 0, rounds = 0;
    for (let round = 0; ; round++) {
      const allowTools = round < tools.maxToolRounds && tools.llmTools.length > 0;
      const out = new StreamingMessage(roomId, EDIT_MS());
      let toolCalls: { id: string; name: string; arguments: string }[] = [];
      for await (const ev of streamCompletion(messages, allowTools ? tools.llmTools : [])) {
        if (ev.type === "text") out.append(ev.text);
        else {
          toolCalls = ev.toolCalls;
          promptTokens += ev.usage?.prompt ?? 0;
          completionTokens += ev.usage?.completion ?? 0;
        }
      }
      const text = await out.finish();
      rounds++;
      if (!toolCalls.length) break;

      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      });
      let endTurn = false;
      for (const c of toolCalls) {
        const t0 = Date.now();
        const res = await executeTool(c.name, c.arguments, roomId);
        log("tool executed", { roomId, tool: c.name, ok: res.ok, ms: Date.now() - t0 });
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(res.llmResult) });
        if (res.endTurn) endTurn = true;
      }
      if (endTurn) break;
    }
    if (handoff.ai_note) await updateHandoff(roomId, { ai_note: null }).catch(() => {});
    log("ai replied", { roomId, eventId, rounds, promptTokens, completionTokens, ms: Date.now() - started });
  } catch (err: any) {
    log("ai error", { roomId, eventId, name: err?.name, status: err?.status, code: err?.code });
    await sendMessage(roomId, "Sorry, something went wrong, please try again.", "m.notice").catch(() => {});
  } finally {
    if (typingTimer) clearInterval(typingTimer);
    await setTyping(roomId, false);
  }
}
