import { useCallback, useEffect, useRef, useState } from "react";
import { ClientEvent, MatrixEventEvent, RoomEvent, RoomMemberEvent, type MatrixEvent, type Room } from "matrix-js-sdk";
import { connect, deleteConversation, type Connection } from "./matrixClient";

export interface WidgetOptions { backendUrl: string; authToken?: string | null; title?: string }

interface Line {
  id: string;
  kind: "own" | "other" | "notice" | "system";
  body: string;
  sender?: string;
}

const HANDOFF = "com.supportchat.handoff";
const INTERNAL = "com.supportchat.internal"; // content flag: notices meant for human agents only

function toLines(room: Room, myId: string): Line[] {
  const out: Line[] = [];
  for (const ev of room.getLiveTimeline().getEvents()) {
    const type = ev.getType();
    if (type === "m.room.member") {
      const c = ev.getContent();
      const who = ev.getStateKey() ?? "";
      if (c.membership === "join" && who.startsWith("@agent_") && ev.getPrevContent()?.membership !== "join") {
        out.push({ id: ev.getId() ?? who, kind: "system", body: `Agent ${c.displayname || who.slice(1).split(":")[0]} joined` });
      }
      continue;
    }
    if (type !== "m.room.message") continue;
    if (ev.isRelation("m.replace")) continue; // edits are applied to the original by the SDK
    const c = ev.getContent();
    if (typeof c.body !== "string" || c[INTERNAL]) continue;
    const mine = ev.getSender() === myId;
    out.push({
      id: ev.getId() ?? ev.getTxnId() ?? String(out.length),
      kind: c.msgtype === "m.notice" ? "notice" : mine ? "own" : "other",
      body: c.body,
      sender: ev.getSender() ?? undefined,
    });
  }
  return out;
}

export function ChatWidget({ opts }: { opts: WidgetOptions }) {
  const [open, setOpen] = useState(false);
  const [conn, setConn] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [typing, setTyping] = useState(false);
  const [status, setStatus] = useState("ai");
  const [text, setText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const connecting = useRef(false);

  const start = useCallback(async () => {
    if (connecting.current) return;
    connecting.current = true;
    setError(null);
    try {
      setConn(await connect(opts.backendUrl, opts.authToken ?? null));
    } catch (e) {
      setError("Could not connect to support. Please try again.");
    } finally {
      connecting.current = false;
    }
  }, [opts.backendUrl, opts.authToken]);

  // connect lazily on first open
  useEffect(() => { if (open && !conn) void start(); }, [open, conn, start]);

  // subscribe to the room
  useEffect(() => {
    if (!conn) return;
    const { client, session } = conn;
    const refresh = () => {
      const room = client.getRoom(session.roomId);
      if (!room) return;
      setLines(toLines(room, session.userId));
      const h = room.currentState.getStateEvents(HANDOFF, "");
      setStatus((h?.getContent()?.status as string) ?? "ai");
      const others = room.getMembers().filter((m) => m.userId !== session.userId && m.typing);
      setTyping(others.length > 0);
    };
    const onEvent = (_e?: MatrixEvent) => refresh();
    client.on(RoomEvent.Timeline, onEvent);
    client.on(RoomEvent.LocalEchoUpdated, onEvent);
    client.on(MatrixEventEvent.Replaced, onEvent);
    client.on(RoomMemberEvent.Typing, onEvent);
    client.on(ClientEvent.Sync, refresh);
    refresh();
    return () => {
      client.off(RoomEvent.Timeline, onEvent);
      client.off(RoomEvent.LocalEchoUpdated, onEvent);
      client.off(MatrixEventEvent.Replaced, onEvent);
      client.off(RoomMemberEvent.Typing, onEvent);
      client.off(ClientEvent.Sync, refresh);
    };
  }, [conn]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, typing, open]);

  // stop the client when the page goes away
  useEffect(() => () => conn?.client.stopClient(), [conn]);

  const send = async () => {
    const body = text.trim();
    if (!body || !conn) return;
    setText("");
    try { await conn.client.sendTextMessage(conn.session.roomId, body); }
    catch { setError("Message failed to send."); }
  };

  const restart = async () => {
    conn?.client.stopClient();
    setConn(null); setLines([]); setStatus("ai");
    await start();
  };

  const doDelete = async () => {
    if (!conn) return;
    setConfirmDelete(false);
    try { await deleteConversation(conn); await restart(); }
    catch { setError("Could not delete the conversation."); }
  };

  const ended = status === "closed";

  return (
    <div className="sc-root">
      {open && (
        <div className="sc-panel" role="dialog" aria-label="Support chat">
          <div className="sc-header">
            <span>{opts.title ?? "Support"}</span>
            <div className="sc-header-actions">
              {conn && !ended && <button className="sc-link" onClick={() => setConfirmDelete(true)}>Delete</button>}
              <button className="sc-link" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </div>
          </div>
          {confirmDelete && (
            <div className="sc-confirm">
              Delete this conversation permanently?
              <div>
                <button onClick={doDelete}>Delete</button>
                <button className="sc-secondary" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </div>
            </div>
          )}
          <div className="sc-messages" ref={listRef}>
            {!conn && !error && <div className="sc-system">Connecting…</div>}
            {error && <div className="sc-system sc-error">{error}</div>}
            {lines.length === 0 && conn && <div className="sc-system">Hi! Ask us anything.</div>}
            {lines.map((l) => (
              <div key={l.id} className={`sc-line sc-${l.kind}`}>{l.body}</div>
            ))}
            {typing && <div className="sc-typing" aria-live="polite">typing…</div>}
            {status === "waiting" && <div className="sc-system">Waiting for a team member to join…</div>}
            {ended && <div className="sc-system">This conversation has ended.</div>}
          </div>
          {ended ? (
            <div className="sc-footer"><button onClick={restart}>Start a new conversation</button></div>
          ) : (
            <form className="sc-footer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type a message…"
                disabled={!conn}
                aria-label="Message"
              />
              <button type="submit" disabled={!conn || !text.trim()}>Send</button>
            </form>
          )}
        </div>
      )}
      {!open && (
        <button className="sc-fab" onClick={() => setOpen(true)} aria-label="Open support chat">💬</button>
      )}
    </div>
  );
}
