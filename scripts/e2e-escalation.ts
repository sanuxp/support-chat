// Human-chat escalation end to end (smoke steps 3-6). Requires agent "alice" (npm run create-agent -- alice alice-pass-123).
import { agentLogin, API, check, enc, handoff, HS, json, messages, newCustomer, resetQueue, say, setPresence, sleep, waitFor } from "./lib.js";

await resetQueue();
const alice = await agentLogin("agent_alice", "alice-pass-123");
const bob = await agentLogin("agent_bob", "bob-pass-123");
await setPresence(bob.token, false); // only alice is available
const p = await setPresence(alice.token, true);
check("agent presence online", p._http === 200);

const c = await newCustomer();
await say(c.accessToken, c.roomId, "Hi, I want to talk to a human please. My invoice is wrong.");

const h = await waitFor("handoff waiting/assigned", async () => {
  const s = await handoff(c.accessToken, c.roomId);
  return (s.status === "assigned" || s.status === "waiting") && s;
});
check("handoff left 'ai'", true, `status=${h.status}`);
const assigned = await waitFor("handoff assigned", async () => {
  const s = await handoff(c.accessToken, c.roomId);
  return s.status === "assigned" && s;
}, 20000);
check("assigned to alice", assigned.agent_id === alice.userId, assigned.agent_id);
check("summary stored", !!assigned.summary && !!assigned.reason);

// agent sees it in the list, accepts and joins
const list = await json("GET", `${API}/api/agent/conversations`, alice.token);
check("agent sees conversation", list.conversations?.some((x: any) => x.roomId === c.roomId));
const acc = await json("POST", `${API}/api/agent/conversations/${enc(c.roomId)}/accept`, alice.token);
check("accept ok", acc._http === 200, JSON.stringify(acc));
const joined = await json("POST", `${HS}/_matrix/client/v3/join/${enc(c.roomId)}`, alice.token, {});
check("agent joined room", joined._http === 200);

const agentHistory = await messages(alice.token, c.roomId);
check("agent can read earlier history (history_visibility shared)", agentHistory.some((m) => m.body.includes("invoice")));
check("exactly one AI summary notice, flagged internal", agentHistory.filter((m) => m.internal && m.msgtype === "m.notice").length === 1);
const custView = await messages(c.accessToken, c.roomId);
check("customer message about the connection was posted", custView.some((m) => m.body.includes("connecting you")));

// agent -> customer
await say(alice.token, c.roomId, "Hello, this is Alice. Let me look at your invoice.");
const got = await waitFor("customer receives agent message", async () => (await messages(c.accessToken, c.roomId)).find((m) => m.sender === alice.userId));
check("customer received agent message", !!got);

// AI must stay silent while assigned
const before = (await messages(c.accessToken, c.roomId)).length;
await say(c.accessToken, c.roomId, "Thanks Alice, it should be 40 not 50.");
await sleep(9000);
const after = await messages(c.accessToken, c.roomId);
const aiAfter = after.slice(before + 1).filter((m) => m.sender.startsWith("@ai_agent"));
check("AI silent while assigned", aiAfter.length === 0, `${aiAfter.length} AI messages`);

// resolve -> back to AI
const rs = await json("POST", `${API}/api/agent/conversations/${enc(c.roomId)}/resolve`, alice.token, { returnToAi: true });
check("resolve ok", rs._http === 200, JSON.stringify(rs));
const back = await handoff(c.accessToken, c.roomId);
check("status back to ai", back.status === "ai" && back.agent_id === null);
const n = (await messages(c.accessToken, c.roomId)).length;
await say(c.accessToken, c.roomId, "Great, one more question: do you ship abroad?");
const reply = await waitFor("AI reply after resolve", async () => {
  const ms = await messages(c.accessToken, c.roomId);
  return ms.length > n + 1 && ms.slice(n + 1).find((m) => m.sender.startsWith("@ai_agent") && m.msgtype === "m.text");
}, 40000);
check("AI replies again after resolve", !!reply);
await setPresence(alice.token, false);
