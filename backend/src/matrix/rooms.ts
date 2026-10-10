import { aiUserId, adminUserId, config } from "../config.js";
import { enc, synapse } from "./synapse.js";

export const HANDOFF_EVENT = "com.supportchat.handoff";
export const CONVERSATION_EVENT = "com.supportchat.conversation";

export type HandoffStatus = "ai" | "waiting" | "assigned" | "escalated_external" | "resolved" | "closed";
export interface HandoffState {
  status: HandoffStatus;
  agent_id: string | null;
  channel: string | null;
  reason: string | null;
  summary: string | null;
  ai_note?: string | null; // one-shot instruction injected into the AI's next turn
  updated_at: number;
}
export const initialHandoff = (): HandoffState => ({
  status: "ai", agent_id: null, channel: null, reason: null, summary: null, ai_note: null, updated_at: Date.now(),
});

/**
 * Create a conversation room as @ai_agent (the appservice sender), invite + join the customer.
 * Room version is pinned to 11 so the explicit power-level model below applies
 * (v12 gives creators infinite power and forbids listing them in power_level_users).
 */
export async function createConversationRoom(customerMxid: string, customerRef: string): Promise<string> {
  const initial_state: any[] = [
    { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "shared" } },
    { type: HANDOFF_EVENT, state_key: "", content: initialHandoff() },
    { type: CONVERSATION_EVENT, state_key: "", content: { customer_ref: customerRef, created_at: Date.now() } },
  ];
  if (config.enableE2ee) {
    initial_state.push({
      type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" },
    });
  }
  const r = await synapse<{ room_id: string }>("POST", "/_matrix/client/v3/createRoom", {
    body: {
      preset: "private_chat",
      room_version: "11",
      name: "Support conversation",
      invite: [customerMxid],
      initial_state,
      power_level_content_override: {
        users: { [aiUserId]: 100, [adminUserId]: 100, [customerMxid]: 0 },
        events_default: 0,
        state_default: 100,
        invite: 100,
        kick: 100,
        ban: 100,
        redact: 50,
        events: { [HANDOFF_EVENT]: 100, [CONVERSATION_EVENT]: 100 },
      },
    },
  });
  await synapse("POST", `/_matrix/client/v3/join/${enc(r.room_id)}`, { actAs: customerMxid, body: {} });
  return r.room_id;
}

export async function getHandoff(roomId: string): Promise<HandoffState> {
  return synapse("GET", `/_matrix/client/v3/rooms/${enc(roomId)}/state/${HANDOFF_EVENT}/`);
}

export async function setHandoff(roomId: string, update: Partial<HandoffState>): Promise<HandoffState> {
  const next = { ...(await getHandoff(roomId)), ...update, updated_at: Date.now() };
  await synapse("PUT", `/_matrix/client/v3/rooms/${enc(roomId)}/state/${HANDOFF_EVENT}/`, { body: next });
  return next;
}

export async function getCustomerRef(roomId: string): Promise<string> {
  try {
    const c = await synapse<{ customer_ref?: string }>("GET", `/_matrix/client/v3/rooms/${enc(roomId)}/state/${CONVERSATION_EVENT}/`);
    return c.customer_ref ?? "";
  } catch { return ""; }
}

export async function inviteUser(roomId: string, userId: string): Promise<void> {
  await synapse("POST", `/_matrix/client/v3/rooms/${enc(roomId)}/invite`, { body: { user_id: userId } });
}

export async function kickUser(roomId: string, userId: string, reason: string): Promise<void> {
  await synapse("POST", `/_matrix/client/v3/rooms/${enc(roomId)}/kick`, { body: { user_id: userId, reason } });
}
