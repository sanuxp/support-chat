// Customer profile passed from the host page (name / email / phone / metadata) — see README "Passing user details".
import { agentLogin, API, check, enc, HS, json, messages, newCustomer, repoRoot, resetQueue, run, say, setPresence, waitFor } from "./lib.js";

const MARK = "zp" + Math.random().toString(36).slice(2, 7);
const H = (v: string) => encodeURIComponent(v);
const psql = async (sql: string) =>
  (await run("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "synapse", "-d", "support_backend", "-tA", "-c", sql], { cwd: repoRoot })).out.trim();

await resetQueue();

// 1. nothing sent -> defaults
const d = await newCustomer();
check("no details sent -> defaults (Test User / testuser@test.com / +9876543210)",
  d.profile.name === "Test User" && d.profile.email === "testuser@test.com" && d.profile.phone === "+9876543210", JSON.stringify(d.profile));

// 2. everything sent (non-ASCII name travels URI-encoded)
const name = `Zoë Müller ${MARK}`, email = `zoe.${MARK}@example.com`, phone = "+91 98123 45678";
const a = await newCustomer(undefined, {
  "X-Customer-Name": H(name), "X-Customer-Email": H(email), "X-Customer-Phone": H(phone),
  "X-Customer-Meta": H(JSON.stringify({ plan: "pro", orders: 3, vip: true, "bad key!": "x", nested: { a: 1 } })),
});
check("name, email and phone are accepted as sent (incl. non-ASCII)", a.profile.name === name && a.profile.email === email && a.profile.phone === phone, JSON.stringify(a.profile));
const dn = await json("GET", `${HS}/_matrix/client/v3/profile/${enc(a.userId)}/displayname`);
check("Matrix display name is the customer's name (agents see it)", dn.displayname === name, dn.displayname);
const meta = JSON.parse(await psql(`select metadata from customers where matrix_user_id='${a.userId}'`));
check("metadata stored; invalid key and nested object dropped",
  meta.plan === "pro" && meta.orders === 3 && meta.vip === true && !("bad key!" in meta) && !("nested" in meta), JSON.stringify(meta));

// 3. invalid values fall back
const b = await newCustomer(undefined, { "X-Customer-Name": H("Valid Name"), "X-Customer-Email": H("not-an-email"), "X-Customer-Phone": H("call me maybe") });
check("invalid email/phone ignored -> defaults; valid name kept",
  b.profile.name === "Valid Name" && b.profile.email === "testuser@test.com" && b.profile.phone === "+9876543210", JSON.stringify(b.profile));

// 4. unsent fields keep stored values; new values update
const again = await newCustomer(a.visitorId);
check("later visit without details keeps the stored details (not reset to defaults)",
  again.profile.name === name && again.profile.email === email && again.userId === a.userId);
const upd = await newCustomer(a.visitorId, { "X-Customer-Phone": H("+44 7700 900123") });
check("a newly sent field updates only that field", upd.profile.phone === "+44 7700 900123" && upd.profile.name === name && upd.profile.email === email);

// 5. CORS preflight allows custom headers from another origin
const pre = await fetch(`${API}/api/customer/session`, {
  method: "OPTIONS",
  headers: { Origin: "https://shop.example.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-customer-name,x-tenant-id" },
});
const allowed = (pre.headers.get("access-control-allow-headers") ?? "").toLowerCase();
check("CORS preflight allows X-Customer-* and arbitrary custom headers", pre.status === 204 && allowed.includes("x-customer-name") && allowed.includes("x-tenant-id"), allowed);

// 6. the AI knows the name; the agent API returns the customer
const alice = await agentLogin("agent_alice", "alice-pass-123");
await setPresence(alice.token, false);
const c = await newCustomer(undefined, { "X-Customer-Name": H("Priya Nair"), "X-Customer-Email": H(`priya.${MARK}@example.com`), "X-Customer-Phone": H("+91 90000 11111") });
await say(c.accessToken, c.roomId, "Before anything else: what is my name and phone number according to your records? Answer in one short sentence.");
const reply = await waitFor("AI reply that uses the profile", async () =>
  (await messages(c.accessToken, c.roomId)).find((m) => m.sender.startsWith("@ai_agent") && m.msgtype === "m.text" && /Priya/.test(m.body)), 40000).catch(() => null);
check("AI uses the customer's name from the profile", !!reply, reply?.body.slice(0, 90));

await setPresence(alice.token, true);
await say(c.accessToken, c.roomId, "Thanks. I also want to talk to a human agent now, please. My order is late.");
const row = await waitFor("agent list has the customer", async () => {
  const l = await json("GET", `${API}/api/agent/conversations`, alice.token);
  return l.conversations?.find((x: any) => x.roomId === c.roomId);
}, 45000);
check("agent queue shows the customer's name, email and phone",
  row.customer?.name === "Priya Nair" && row.customer?.phone === "+91 90000 11111" && row.customer?.email === `priya.${MARK}@example.com`);
const acc = await json("POST", `${API}/api/agent/conversations/${enc(c.roomId)}/accept`, alice.token);
check("accept response includes the customer", acc.customer?.name === "Priya Nair");
await setPresence(alice.token, false);
await resetQueue();

// 7. personal data never reaches the logs
const logs = (await run("docker", ["compose", "logs", "backend", "--no-log-prefix", "--since", "20m"], { cwd: repoRoot })).out;
check("logs contain none of the personal details", !logs.includes(MARK) && !logs.includes("Priya") && !logs.includes("Müller") && !logs.includes("+91 98123"));
