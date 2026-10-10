import { useCallback, useEffect, useState } from "react";
import { ClientEvent, RoomStateEvent, type MatrixClient } from "matrix-js-sdk";
import { ConversationView } from "./ConversationView";
import { Login } from "./Login";
import { Queue, type ConversationRow } from "./Queue";
import { api, loadSession, login, logout, startClient, type Session } from "./matrixClient";

const HEARTBEAT_MS = 30_000;

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession());
  const [client, setClient] = useState<MatrixClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  // (re)start the Matrix client whenever we have a session
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let c: MatrixClient | null = null;
    startClient(session)
      .then((cl) => { c = cl; if (stopped) cl.stopClient(); else setClient(cl); })
      .catch(() => { setError("Session expired, please sign in again."); void doLogout(null); });
    return () => { stopped = true; c?.stopClient(); setClient(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const token = session?.accessToken ?? "";

  const refresh = useCallback(async () => {
    if (!token) return;
    try { setRows((await api<{ conversations: ConversationRow[] }>(token, "GET", "/api/agent/conversations")).conversations); }
    catch (e: any) { setError(e.message); }
  }, [token]);

  // queue: poll + refetch whenever handoff state changes anywhere we can see
  useEffect(() => {
    if (!client) return;
    void refresh();
    const t = setInterval(refresh, 5000);
    const onState = (ev: any) => { if (ev?.getType?.() === "com.supportchat.handoff") void refresh(); };
    client.on(RoomStateEvent.Events, onState);
    client.on(ClientEvent.Room, refresh);
    return () => { clearInterval(t); client.off(RoomStateEvent.Events, onState); client.off(ClientEvent.Room, refresh); };
  }, [client, refresh]);

  // presence heartbeat (backend treats a stale heartbeat as offline)
  useEffect(() => {
    if (!token || !online) return;
    const beat = () => api(token, "POST", "/api/agent/presence", { online: true }).catch(() => {});
    void beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [token, online]);

  const toggleOnline = async () => {
    const next = !online;
    setOnline(next);
    if (!next) await api(token, "POST", "/api/agent/presence", { online: false }).catch(() => {});
  };

  async function doLogout(cl: MatrixClient | null) {
    if (token) await api(token, "POST", "/api/agent/presence", { online: false }).catch(() => {});
    await logout(cl);
    setOnline(false); setOpen(null); setRows([]); setSession(null);
  }

  if (!session) {
    return (
      <Login
        error={error}
        onLogin={async (u, p) => {
          setError(null);
          try { setSession(await login(u, p)); } catch { setError("Sign-in failed. Check your username and password."); }
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="top">
        <strong>Agent console</strong>
        <span className="muted">{session.userId}</span>
        <div className="spacer" />
        <button className={online ? "online" : "secondary"} onClick={toggleOnline}>
          <span className={`dot ${online ? "on" : ""}`} /> {online ? "Online" : "Offline"}
        </button>
        <button className="secondary" onClick={() => doLogout(client)}>Sign out</button>
      </header>
      {error && <p className="error banner" onClick={() => setError(null)}>{error}</p>}
      <main>
        {!client && <p className="muted">Connecting…</p>}
        {client && open && (
          <ConversationView client={client} token={token} roomId={open} onClose={() => { setOpen(null); void refresh(); }} />
        )}
        {client && !open && <Queue rows={rows} canTake={online} onOpen={(id) => setOpen(id)} />}
      </main>
    </div>
  );
}
