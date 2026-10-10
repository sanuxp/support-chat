import { randomUUID } from "node:crypto";
import { aiUserId } from "../config.js";
import { enc, synapse } from "./synapse.js";

/** All calls here act as @ai_agent (the appservice sender) unless noted. */

export async function sendMessage(
  roomId: string, body: string, msgtype: "m.text" | "m.notice" = "m.text", extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await synapse<{ event_id: string }>(
    "PUT", `/_matrix/client/v3/rooms/${enc(roomId)}/send/m.room.message/${randomUUID()}`,
    { body: { msgtype, body, ...extra } },
  );
  return r.event_id;
}

export async function editMessage(roomId: string, eventId: string, body: string): Promise<void> {
  await synapse("PUT", `/_matrix/client/v3/rooms/${enc(roomId)}/send/m.room.message/${randomUUID()}`, {
    body: {
      msgtype: "m.text",
      body: `* ${body}`,
      "m.new_content": { msgtype: "m.text", body },
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    },
  });
}

export async function setTyping(roomId: string, typing: boolean): Promise<void> {
  await synapse("PUT", `/_matrix/client/v3/rooms/${enc(roomId)}/typing/${enc(aiUserId)}`, {
    body: typing ? { typing: true, timeout: 30000 } : { typing: false },
  }).catch(() => {}); // typing is best-effort
}

export interface HistoryMessage { sender: string; body: string; msgtype: string; internal?: boolean }

/** Last `limit` text messages in chronological order, with edits (m.replace) applied. */
export async function getHistory(roomId: string, limit: number): Promise<HistoryMessage[]> {
  const r = await synapse<{ chunk: any[] }>(
    "GET", `/_matrix/client/v3/rooms/${enc(roomId)}/messages?dir=b&limit=${limit * 2}`,
  );
  const out: HistoryMessage[] = [];
  for (const ev of r.chunk) {
    if (ev.type !== "m.room.message") continue;
    if (ev.content?.["m.relates_to"]?.rel_type === "m.replace") continue; // edit events themselves
    const edit = ev.unsigned?.["m.relations"]?.["m.replace"]?.content?.["m.new_content"];
    const content = edit ?? ev.content;
    if (typeof content?.body !== "string") continue;
    out.push({
      sender: ev.sender, body: content.body, msgtype: content.msgtype ?? "m.text",
      internal: !!ev.content?.["com.supportchat.internal"],
    });
    if (out.length >= limit) break;
  }
  return out.reverse();
}

/** Plain-text transcript for emails/webhooks. Agent-only notes are left out. */
export async function getTranscript(roomId: string, limit = 200): Promise<string> {
  const msgs = await getHistory(roomId, limit);
  return msgs
    .filter((x) => !x.internal && x.msgtype !== "m.notice")
    .map((x) => `${x.sender === aiUserId ? "Assistant" : x.sender.startsWith("@customer_") ? "Customer" : "Agent"}: ${x.body}`)
    .join("\n");
}
