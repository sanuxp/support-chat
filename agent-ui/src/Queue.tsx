export interface ConversationRow {
  roomId: string;
  status: "waiting" | "assigned" | string;
  assignedAgent: string | null;
  reason: string | null;
  summary: string | null;
  updatedAt: string;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function Row({ c, onOpen, label }: { c: ConversationRow; onOpen: () => void; label: string }) {
  return (
    <li className="row" onClick={onOpen}>
      <div className="row-main">
        <strong>{c.reason || "Conversation"}</strong>
        <span className="muted"> · {ago(c.updatedAt)}</span>
        {c.summary && <p className="summary">{c.summary}</p>}
      </div>
      <button onClick={(e) => { e.stopPropagation(); onOpen(); }}>{label}</button>
    </li>
  );
}

export function Queue({ rows, onOpen, canTake }: { rows: ConversationRow[]; onOpen: (roomId: string) => void; canTake: boolean }) {
  const waiting = rows.filter((r) => r.status === "waiting");
  const mine = rows.filter((r) => r.status === "assigned");
  return (
    <div className="queue">
      <section>
        <h2>My conversations <span className="count">{mine.length}</span></h2>
        {mine.length === 0 && <p className="muted">Nothing assigned to you.</p>}
        <ul>{mine.map((c) => <Row key={c.roomId} c={c} onOpen={() => onOpen(c.roomId)} label="Open" />)}</ul>
      </section>
      <section>
        <h2>Waiting <span className="count">{waiting.length}</span></h2>
        {waiting.length === 0 && <p className="muted">The queue is empty.</p>}
        {!canTake && waiting.length > 0 && <p className="muted">Go online to take conversations.</p>}
        <ul>{waiting.map((c) => <Row key={c.roomId} c={c} onOpen={() => onOpen(c.roomId)} label={canTake ? "Take" : "View"} />)}</ul>
      </section>
    </div>
  );
}
