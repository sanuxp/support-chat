// Milestone 2/3 check: session -> send message as customer -> read it back. Node 20+ (fetch only).
const API = process.env.API ?? "http://localhost:3000";
const post = (u, b, h = {}) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));
const s = await post(`${API}/api/customer/session`, {});
console.log("session", s.status, { userId: s.body.userId, roomId: s.body.roomId, hasToken: !!s.body.accessToken });
const hs = process.env.HS ?? "http://localhost:8008";
const auth = { Authorization: `Bearer ${s.body.accessToken}` };
const txn = Date.now();
const put = await fetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(s.body.roomId)}/send/m.room.message/${txn}`, { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ msgtype: "m.text", body: "hello from test" }) });
console.log("send", put.status, await put.json());
const st = await fetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(s.body.roomId)}/state/com.supportchat.handoff/`, { headers: auth });
console.log("handoff", st.status, await st.json());
const forbidden = await fetch(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(s.body.roomId)}/state/com.supportchat.handoff/`, { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ status: "assigned" }) });
console.log("customer state write (expect 403)", forbidden.status);
const s2 = await post(`${API}/api/customer/session`, { visitorId: s.body.visitorId });
console.log("same visitor -> same room:", s2.body.roomId === s.body.roomId, "same user:", s2.body.userId === s.body.userId);
