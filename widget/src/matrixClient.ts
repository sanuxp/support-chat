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

/** Details about the person, supplied by the host web page. All optional; the backend applies defaults. */
export interface CustomerInfo { name?: string; email?: string; phone?: string }
export type CustomerMetadata = Record<string, string | number | boolean>;

export interface SessionExtras {
  user?: CustomerInfo;
  metadata?: CustomerMetadata;
  /** Extra HTTP headers sent verbatim with the session request (e.g. for a gateway in front of the backend). */
  customHeaders?: Record<string, string>;
}

// HTTP header values are Latin-1 only, so values are URI-encoded (the backend decodes them).
const enc = (v: string) => encodeURIComponent(v);

export function sessionHeaders(authToken: string | null, extras: SessionExtras = {}): Record<string, string> {
  // custom headers first, so the widget's own headers (Content-Type, Authorization, X-Customer-*) always win
  const headers: Record<string, string> = { ...(extras.customHeaders ?? {}), "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const u = extras.user ?? {};
  if (u.name) headers["X-Customer-Name"] = enc(u.name);
  if (u.email) headers["X-Customer-Email"] = enc(u.email);
  if (u.phone) headers["X-Customer-Phone"] = enc(u.phone);
  if (extras.metadata && Object.keys(extras.metadata).length) headers["X-Customer-Meta"] = enc(JSON.stringify(extras.metadata));
  return headers;
}

export async function createSession(backendUrl: string, authToken: string | null, extras: SessionExtras = {}): Promise<SessionInfo> {
  const headers = sessionHeaders(authToken, extras);
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

export async function connect(backendUrl: string, authToken: string | null, extras: SessionExtras = {}): Promise<Connection> {
  const session = await createSession(backendUrl, authToken, extras);
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
