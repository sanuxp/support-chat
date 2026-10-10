// End-to-end smoke test (spec section 10). Run: npm run smoke-test
// Needs: docker compose stack up (init.sh done), Node 20+, Docker CLI on PATH.
// It temporarily edits backend/config/tools.yaml (restored at the end), creates agent "alice" if missing,
// and closes leftover waiting/assigned conversations first.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAgent } from "./create-agent.js";
import { startEchoServer } from "./echo-server.js";
import {
  agentLogin, API, check, enc, env, handoff, HS, json, messages, newCustomer, repoRoot, resetQueue, run, say, setPresence, sleep, waitFor,
} from "./lib.js";

const yamlPath = fileURLToPath(new URL("../backend/config/tools.yaml", import.meta.url));
const originalYaml = await readFile(yamlPath, "utf8");
const MARK = "zq" + Math.random().toString(36).slice(2, 8); // unique string that must never appear in backend logs
const SYNAPSE_ADMIN = env.SYNAPSE_ADMIN_URL ?? "http://localhost:8009";
const reload = () =>
  fetch(`${API}/api/admin/reload-config`, { method: "POST", headers: { Authorization: `Bearer ${env.ADMIN_API_TOKEN}` } }).then((r) => r.status);
const aiTexts = (ms: Awaited<ReturnType<typeof messages>>) => ms.filter((m) => m.sender.startsWith("@ai_agent") && m.msgtype === "m.text");
const section = (t: string) => console.log(`\n== ${t}`);

let echo: Awaited<ReturnType<typeof startEchoServer>> | undefined;
let agents: { alice?: { token: string; userId: string }; bob?: { token: string; userId: string } } = {};

try {
  await resetQueue();
  await createAgent("alice", "alice-pass-123", "Alice");
  agents.alice = await agentLogin("agent_alice", "alice-pass-123");
  const alice = agents.alice;

  // 1 ---------------------------------------------------------------------------------------------
  section("1. customer session (anonymous)");
  const c = await newCustomer();
  check("session returns user, token and room", !!c.userId && !!c.accessToken && c.roomId.startsWith("!"));

  // 2 ---------------------------------------------------------------------------------------------
  section("2. Hello -> AI reply within 30 s");
  const t0 = Date.now();
  await say(c.accessToken, c.roomId, `Hello ${MARK}`);
  const hello = await waitFor("AI reply", async () => aiTexts(await messages(c.accessToken, c.roomId))[0], 30000);
  check("AI replied", !!hello, `${Date.now() - t0} ms`);

  // 3 ---------------------------------------------------------------------------------------------
  section("3. 'talk to a human' -> waiting -> assigned");
  await setPresence(alice.token, true);
  await say(c.accessToken, c.roomId, "I want to talk to a human, please. My invoice is wrong.");
  await waitFor("waiting or assigned", async () => ["waiting", "assigned"].includes((await handoff(c.accessToken, c.roomId)).status), 45000);
  const assigned = await waitFor("assigned", async () => {
    const s = await handoff(c.accessToken, c.roomId);
    return s.status === "assigned" && s;
  }, 20000);
  check("status assigned to the online test agent", assigned.agent_id === alice.userId);
  await json("POST", `${API}/api/agent/conversations/${enc(c.roomId)}/accept`, alice.token);
  await json("POST", `${HS}/_matrix/client/v3/join/${enc(c.roomId)}`, alice.token, {});

  // 4 ---------------------------------------------------------------------------------------------
  section("4. agent message reaches customer");
  await say(alice.token, c.roomId, "Hi, this is Alice from support.");
  const got = await waitFor("customer sees agent message", async () => (await messages(c.accessToken, c.roomId)).find((m) => m.sender === alice.userId), 15000);
  check("customer received the agent's message", !!got);

  // 5 ---------------------------------------------------------------------------------------------
  section("5. AI silent while assigned");
  const before = (await messages(c.accessToken, c.roomId)).length;
  await say(c.accessToken, c.roomId, "Thanks Alice, it should be 40 not 50.");
  await sleep(9000);
  const after = (await messages(c.accessToken, c.roomId)).slice(before + 1);
  check("no AI messages while assigned", after.filter((m) => m.sender.startsWith("@ai_agent")).length === 0);

  // 6 ---------------------------------------------------------------------------------------------
  section("6. resolve (returnToAi) -> AI replies again");
  const rs = await json("POST", `${API}/api/agent/conversations/${enc(c.roomId)}/resolve`, alice.token, { returnToAi: true });
  check("resolve accepted", rs._http === 200);
  const n6 = (await messages(c.accessToken, c.roomId)).length;
  await say(c.accessToken, c.roomId, "Great. Do you ship internationally?");
  const again = await waitFor("AI reply after resolve", async () => {
    const ms = await messages(c.accessToken, c.roomId);
    return aiTexts(ms.slice(n6 + 1))[0];
  }, 40000);
  check("AI replies after the conversation returned to it", !!again);
  await setPresence(alice.token, false);

  // 7 ---------------------------------------------------------------------------------------------
  section("7. email escalation with no agent online");
  const c7 = await newCustomer();
  const email = `smoke.${MARK}@example.com`;
  await say(c7.accessToken, c7.roomId, `Please escalate this to the support team by email. My email address is ${email} and that is correct, so go ahead and send it now. The problem: my order never arrived.`);
  let esc: any = await waitFor("escalated_external", async () => {
    const s = await handoff(c7.accessToken, c7.roomId);
    return s.status === "escalated_external" && s;
  }, 40000).catch(() => null);
  if (!esc) {
    await say(c7.accessToken, c7.roomId, `Yes, ${email} is correct. Please send the email to support now.`);
    esc = await waitFor("escalated_external (2nd try)", async () => {
      const s = await handoff(c7.accessToken, c7.roomId);
      return s.status === "escalated_external" && s;
    }, 40000).catch(() => null);
  }
  check("handoff status escalated_external (only set after the email was sent)", !!esc);
  check("channel recorded", esc?.channel === "escalate_via_email", esc?.channel);
  const n7 = (await messages(c7.accessToken, c7.roomId)).length;
  await say(c7.accessToken, c7.roomId, "Thanks. Also, what are your shipping options?");
  const keeps = await waitFor("AI keeps replying", async () => aiTexts((await messages(c7.accessToken, c7.roomId)).slice(n7 + 1))[0], 40000).catch(() => null);
  check("AI keeps replying after the email escalation", !!keeps);
  if (env.SMTP_HOST === "mailpit") {
    const list: any = await (await fetch("http://localhost:8025/api/v1/messages")).json();
    const hit = (list.messages ?? []).find((m: any) => (m.Subject ?? "").startsWith("[Chat escalation]") && m.To?.some((t: any) => t.Address === env.SUPPORT_EMAIL_TO));
    const full: any = hit ? await (await fetch(`http://localhost:8025/api/v1/message/${hit.ID}`)).json() : null;
    check("email arrived in Mailpit", !!hit, hit?.Subject);
    check("email has summary, customer address and transcript", !!full && full.Text.includes(email) && /Summary:/.test(full.Text) && full.Text.includes("--- Transcript ---") && full.Text.includes("Customer:"));
  } else {
    console.log(`SKIP  Mailpit inbox check (SMTP_HOST=${env.SMTP_HOST}); status escalated_external above proves the SMTP send succeeded`);
  }

  // 8 ---------------------------------------------------------------------------------------------
  section("8. webhook tool (create_ticket) against a local echo server");
  echo = await startEchoServer(env.WEBHOOK_SIGNING_SECRET, 4010, { ticket_id: `TCK-${MARK}`, status: "created" });
  await writeFile(
    yamlPath,
    originalYaml
      .replace(/(- name: create_ticket\n\s+enabled: )false/, "$1true")
      .replace("https://tickets.internal/api/tickets", "http://host.docker.internal:4010/tickets"),
  );
  check("reload with create_ticket enabled", (await reload()) === 200);
  const c8 = await newCustomer();
  await say(c8.accessToken, c8.roomId, `Please create a support ticket now. Title: "Broken widget ${MARK}", priority high, summary: the chat button does nothing on my phone. After creating it, tell me the exact ticket id the system returned.`);
  const call = await waitFor("echo server receives webhook", async () => echo!.received[0], 45000).catch(() => null);
  check("webhook was called", !!call);
  check("X-SupportChat-Signature is a valid HMAC of the body", !!call?.signatureValid);
  check("custom header resolved from env (${TICKETS_API_TOKEN})", call?.headers.authorization === `Bearer ${env.TICKETS_API_TOKEN}`);
  check("payload has tool, args, room_id", call?.body?.tool === "create_ticket" && !!call?.body?.args?.title && call?.body?.room_id === c8.roomId);
  const seen = await waitFor("AI mentions ticket id", async () => aiTexts(await messages(c8.accessToken, c8.roomId)).find((m) => m.body.includes(`TCK-${MARK}`)), 30000).catch(() => null);
  check("webhook response reached the LLM (AI quotes the ticket id)", !!seen);
  await echo.close(); echo = undefined;
  await writeFile(yamlPath, originalYaml);
  await reload();

  // 9 ---------------------------------------------------------------------------------------------
  section("9. broken tools.yaml -> backend refuses to start");
  await writeFile(yamlPath, originalYaml.replace("handler: human_chat", "handler: human_chatt"));
  const boot = await run("docker", ["compose", "run", "--rm", "--no-deps", "-e", "BACKEND_PORT=3999", "backend"], { cwd: repoRoot, timeoutMs: 120000 });
  const out = boot.out;
  check("exit code is non-zero", boot.code !== 0, `exit ${boot.code}`);
  check("error names the bad entry", /CONFIG ERROR/.test(out) && /tools\[0\] "escalate_to_human_chat"\.handler/.test(out));
  await writeFile(yamlPath, originalYaml);

  // 10 --------------------------------------------------------------------------------------------
  section("10. customer deletes conversation");
  const c10 = await newCustomer();
  await say(c10.accessToken, c10.roomId, `Hi ${MARK} delete test`);
  await sleep(1500);
  const other = await newCustomer();
  const forbidden = await fetch(`${API}/api/customer/conversations/${enc(c10.roomId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${other.backendToken}` } });
  check("another customer cannot delete it (404)", forbidden.status === 404);
  const del = await fetch(`${API}/api/customer/conversations/${enc(c10.roomId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${c10.backendToken}` } });
  check("owner delete accepted", del.status === 200 || del.status === 202, `HTTP ${del.status}`);
  const asLogin: any = await json("POST", `${HS}/_matrix/client/v3/login`, env.AS_TOKEN, { type: "m.login.application_service", identifier: { type: "m.id.user", user: "svc_admin" } });
  const adminView = await json("GET", `${SYNAPSE_ADMIN}/_synapse/admin/v1/rooms/${enc(c10.roomId)}`, asLogin.access_token);
  check("admin API confirms the room is gone", adminView._http === 404, `HTTP ${adminView._http}`);
  const fresh = await newCustomer(c10.visitorId);
  check("new session for the same visitor creates a new room", fresh.roomId !== c10.roomId && fresh.userId === c10.userId);

  // 11 --------------------------------------------------------------------------------------------
  section("11. backend logs contain no message bodies or tool arguments");
  const logs = (await run("docker", ["compose", "logs", "backend", "--no-log-prefix", "--since", "30m"], { cwd: repoRoot })).out;
  check("logs are non-empty (test is not vacuous)", logs.includes('"msg"'), `${logs.length} chars`);
  check(`marker "${MARK}" (in messages, email address, ticket title) never logged`, !logs.includes(MARK));
  check("customer email address never logged", !logs.includes("@example.com\"") && !logs.includes(email));
  check("no 'Broken widget' / invoice text logged", !/Broken widget|invoice is wrong|never arrived/i.test(logs));
} catch (e: any) {
  check("smoke test ran to completion", false, e?.message);
} finally {
  await writeFile(yamlPath, originalYaml);
  await reload().catch(() => {});
  await echo?.close().catch(() => {});
  for (const a of [agents.alice, agents.bob]) if (a) await setPresence(a.token, false).catch(() => {});
  console.log(process.exitCode ? "\nSMOKE TEST FAILED" : "\nSMOKE TEST PASSED");
}
