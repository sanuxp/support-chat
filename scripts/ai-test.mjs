// Milestone 4 check: customer says hello -> AI replies (streamed via edits) within 30s.
const API = process.env.API ?? "http://localhost:3000", HS = process.env.HS ?? "http://localhost:8008";
const j = (r) => r.json();
const s = await fetch(`${API}/api/customer/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(j);
const H = { Authorization: `Bearer ${s.accessToken}`, "Content-Type": "application/json" };
const room = encodeURIComponent(s.roomId);
const text = process.argv[2] ?? "Hello! What can you help me with?";
const t0 = Date.now();
await fetch(`${HS}/_matrix/client/v3/rooms/${room}/send/m.room.message/${Date.now()}`, { method: "PUT", headers: H, body: JSON.stringify({ msgtype: "m.text", body: text }) });
let seen = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const m = await fetch(`${HS}/_matrix/client/v3/rooms/${room}/messages?dir=b&limit=10`, { headers: H }).then(j);
  const ai = m.chunk.filter((e) => e.type === "m.room.message" && e.sender.startsWith("@ai_agent") && !e.content["m.relates_to"]);
  if (ai.length) {
    const ev = ai[0];
    const final = ev.unsigned?.["m.relations"]?.["m.replace"]?.content?.["m.new_content"]?.body ?? ev.content.body;
    const edited = !!ev.unsigned?.["m.relations"]?.["m.replace"];
    if (!seen) { console.log(`first AI event after ${Date.now() - t0}ms`); seen = true; }
    if (Date.now() - t0 > 6000 || final.length > 20) { console.log({ msgtype: ev.content.msgtype, edited, reply: final }); process.exit(0); }
  }
}
console.log("NO AI REPLY within 30s"); process.exit(1);
