import { useEffect, useRef, useState } from "react";
import { ClientEvent, MatrixEventEvent, RoomEvent, type MatrixClient, type Room } from "matrix-js-sdk";
import type { CustomerInfo } from "./Queue";
import { api } from "./matrixClient";

const INTERNAL = "com.supportchat.internal";

interface Line { id: string; who: "me" | "customer" | "ai" | "agent" | "notice" | "summary"; name: string; body: string }

function toLines(room: Room, me: string): Line[] {
  const out: Line[] = [];
  for (const ev of room.getLiveTimeline().getEvents()) {
    if (ev.getType() !== "m.room.message" || ev.isRelation("m.replace")) continue;
    const c = ev.getContent();
    if (typeof c.body !== "string") continue;
    const sender = ev.getSender() ?? "";
    const base = { id: ev.getId() ?? ev.getTxnId() ?? String(out.length), body: c.body };
    if (c[INTERNAL]) out.push({ ...base, who: "summary", name: "AI summary" });
    else if (c.msgtype === "m.notice") out.push({ ...base, who: "notice", name: "System" });
    else if (sender === me) out.push({ ...base, who: "me", name: "You" });
    else if (sender.startsWith("@customer_")) out.push({ ...base, who: "customer", name: "Customer" });
    else if (sender.startsWith("@ai_agent")) out.push({ ...base, who: "ai", name: "AI assistant" });
    else out.push({ ...base, who: "agent", name: room.getMember(sender)?.name ?? sender });
  }
  return out;
}

export function ConversationView({
  client, token, roomId, onClose,
}: { client: MatrixClient; token: string; roomId: string; onClose: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [ended, setEnded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [customer, setCustomer] = useState<CustomerInfo | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const me = client.getUserId() ?? "";

  // accept (assigns if still queued / re-invites), join, then load full history
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const acc = await api<{ customer?: CustomerInfo }>(token, "POST", `/api/agent/conversations/${encodeURIComponent(roomId)}/accept`);
        if (!cancelled && acc.customer) setCustomer(acc.customer);
        await client.joinRoom(roomId);
        let room = client.getRoom(roomId);
        for (let i = 0; i < 20 && !room; i++) { await new Promise((r) => setTimeout(r, 250)); room = client.getRoom(roomId); }
        if (!room) throw new Error("Could not open the room");
        // history_visibility is "shared": paginate back to see everything before we joined
        for (let i = 0; i < 5; i++) {
          const more = await client.paginateEventTimeline(room.getLiveTimeline(), { backwards: true, limit: 50 });
          if (!more) break;
        }
        if (!cancelled) setReady(true);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? "Could not open conversation");
      }
    })();
    return () => { cancelled = true; };
  }, [client, token, roomId]);

  useEffect(() => {
    if (!ready) return;
    const refresh = () => {
      const room = client.getRoom(roomId);
      if (!room) return;
      setLines(toLines(room, me));
      const st = room.currentState.getStateEvents("com.supportchat.handoff", "")?.getContent();
      setEnded(!!st && !(st.status === "assigned" && st.agent_id === me));
    };
    client.on(RoomEvent.Timeline, refresh);
    client.on(RoomEvent.LocalEchoUpdated, refresh);
    client.on(MatrixEventEvent.Replaced, refresh);
    client.on(ClientEvent.Sync, refresh);
    refresh();
    return () => {
      client.off(RoomEvent.Timeline, refresh);
      client.off(RoomEvent.LocalEchoUpdated, refresh);
      client.off(MatrixEventEvent.Replaced, refresh);
      client.off(ClientEvent.Sync, refresh);
    };
  }, [ready, client, roomId, me]);

  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [lines]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    try { await client.sendTextMessage(roomId, body); } catch { setError("Message failed to send"); }
  };

  const resolve = async (returnToAi: boolean) => {
    setBusy(true);
    try {
      await api(token, "POST", `/api/agent/conversations/${encodeURIComponent(roomId)}/resolve`, { returnToAi });
      onClose();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="conv">
      <header>
        <button className="secondary" onClick={onClose}>← Back</button>
        <div className="spacer" />
        <button disabled={busy || ended} onClick={() => resolve(true)}>Resolve → back to AI</button>
        <button className="secondary" disabled={busy || ended} onClick={() => resolve(false)}>Resolve &amp; close</button>
      </header>
      {customer && (
        <div className="customer-card">
          <strong>{customer.name}</strong>
          <a href={`mailto:${customer.email}`}>{customer.email}</a>
          <a href={`tel:${customer.phone}`}>{customer.phone}</a>
          {Object.entries(customer.metadata).map(([k, v]) => (
            <span key={k} className="chip">{k}: {String(v)}</span>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="timeline" ref={listRef}>
        {!ready && !error && <p className="muted">Loading…</p>}
        {lines.map((l) => (
          <div key={l.id} className={`msg ${l.who}`}>
            <div className="who">{l.name}</div>
            <div className="body">{l.body}</div>
          </div>
        ))}
        {ended && ready && <p className="muted center">You are no longer assigned to this conversation.</p>}
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply to the customer…" disabled={!ready || ended} />
        <button type="submit" disabled={!ready || ended || !text.trim()}>Send</button>
      </form>
    </div>
  );
}

