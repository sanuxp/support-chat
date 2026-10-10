import { ClientEvent, createClient, SyncState, type MatrixClient } from "matrix-js-sdk";

// Crypto is intentionally off in v1. Flip VITE_ENABLE_E2EE=true at build time later to enable it.
const ENABLE_E2EE = import.meta.env.VITE_ENABLE_E2EE === "true";

export interface SessionInfo {
  visitorId?: string;
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  roomId: string;
  backendToken: string;
}

export interface Connection {
  client: MatrixClient;
  session: SessionInfo;
  backendUrl: string;
}

const VISITOR_KEY = "supportchat.visitorId";
const safeStorage = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export async function createSession(backendUrl: string, authToken: string | null): Promise<SessionInfo> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(`${backendUrl}/api/customer/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ visitorId: safeStorage.get(VISITOR_KEY) ?? undefined }),
  });
  if (!res.ok) throw new Error(`session failed (${res.status})`);
  const s = (await res.json()) as SessionInfo;
  if (s.visitorId) safeStorage.set(VISITOR_KEY, s.visitorId);
  return s;
}

export async function connect(backendUrl: string, authToken: string | null): Promise<Connection> {
  const session = await createSession(backendUrl, authToken);
  const client = createClient({
    baseUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId,
  });
  if (ENABLE_E2EE) await client.initRustCrypto();
  await new Promise<void>((resolve, reject) => {
    const onSync = (state: SyncState) => {
      if (state === SyncState.Prepared) { client.off(ClientEvent.Sync, onSync); resolve(); }
      else if (state === SyncState.Error) { client.off(ClientEvent.Sync, onSync); reject(new Error("sync error")); }
    };
    client.on(ClientEvent.Sync, onSync);
    void client.startClient({ initialSyncLimit: 50, lazyLoadMembers: true });
  });
  return { client, session, backendUrl };
}

export async function deleteConversation(conn: Connection): Promise<void> {
  const res = await fetch(`${conn.backendUrl}/api/customer/conversations/${encodeURIComponent(conn.session.roomId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${conn.session.backendToken}` },
  });
  if (!res.ok) throw new Error(`delete failed (${res.status})`);
}
