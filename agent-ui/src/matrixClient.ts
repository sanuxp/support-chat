import { ClientEvent, createClient, RoomMemberEvent, SyncState, type MatrixClient } from "matrix-js-sdk";

// In production the console is served by Caddy on the same origin as Synapse and the backend.
// With `vite dev` (port 5174) they live on Caddy at :8008 unless overridden.
const defaultOrigin = location.port === "5174" ? "http://localhost:8008" : location.origin;
export const HOMESERVER_URL: string = import.meta.env.VITE_HOMESERVER_URL ?? defaultOrigin;
export const BACKEND_URL: string = import.meta.env.VITE_BACKEND_URL ?? defaultOrigin;

const KEY = "supportchat.agent.session";

export interface Session { userId: string; accessToken: string; deviceId: string }

export const loadSession = (): Session | null => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; }
};
const saveSession = (s: Session | null) => {
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* ignore */ }
};

export async function login(username: string, password: string): Promise<Session> {
  const tmp = createClient({ baseUrl: HOMESERVER_URL });
  const r = await tmp.login("m.login.password", {
    identifier: { type: "m.id.user", user: username },
    password,
    initial_device_display_name: "Agent console",
  });
  const s = { userId: r.user_id, accessToken: r.access_token, deviceId: r.device_id };
  saveSession(s);
  return s;
}

export async function logout(client: MatrixClient | null): Promise<void> {
  try { await client?.logout(true); } catch { /* token may already be invalid */ }
  client?.stopClient();
  saveSession(null);
}

export async function startClient(s: Session): Promise<MatrixClient> {
  const client = createClient({ baseUrl: HOMESERVER_URL, accessToken: s.accessToken, userId: s.userId, deviceId: s.deviceId });
  // join rooms the backend invites us to (this is how an assignment reaches the agent)
  client.on(RoomMemberEvent.Membership, (_ev, member) => {
    if (member.userId === s.userId && member.membership === "invite") {
      client.joinRoom(member.roomId).catch(() => {});
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onSync = (state: SyncState) => {
      if (state === SyncState.Prepared) { client.off(ClientEvent.Sync, onSync); resolve(); }
      else if (state === SyncState.Error) { client.off(ClientEvent.Sync, onSync); reject(new Error("sync failed")); }
    };
    client.on(ClientEvent.Sync, onSync);
    void client.startClient({ initialSyncLimit: 30, lazyLoadMembers: true });
  });
  return client;
}

export async function api<T = any>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).message ?? `request failed (${res.status})`);
  return data as T;
}
