// Tool system + fallback checks (milestones 7-8). Edits backend/config/tools.yaml temporarily and restores it.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { agentLogin, API, check, env, handoff, json, messages, newCustomer, resetQueue, say, setPresence, sleep, waitFor } from "./lib.js";

const yamlPath = fileURLToPath(new URL("../backend/config/tools.yaml", import.meta.url));
const original = await readFile(yamlPath, "utf8");
const reload = (token?: string) =>
  fetch(`${API}/api/admin/reload-config`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then(async (r) => ({ http: r.status, body: await r.json().catch(() => ({})) as any }));

await resetQueue();
try {
  // --- reload endpoint auth + validation --------------------------------------------------------
  check("reload without token -> 401", (await reload()).http === 401);
  check("reload with wrong token -> 401", (await reload("nope")).http === 401);
  check("reload with admin token -> 200", (await reload(env.ADMIN_API_TOKEN)).http === 200);

  await writeFile(yamlPath, original.replace("name: escalate_via_email", "name: escalate_via_email!!"));
  const bad = await reload(env.ADMIN_API_TOKEN);
  check("invalid tools.yaml -> 400 with pointer to the bad entry", bad.http === 400 && /tools\[1\].*name/.test(bad.body.error), bad.body.error?.split("\n")[1]?.trim());
  await writeFile(yamlPath, original.replace("fallback_tool: escalate_via_email", "fallback_tool: does_not_exist"));
  const bad2 = await reload(env.ADMIN_API_TOKEN);
  check("unknown fallback_tool rejected", bad2.http === 400 && /does_not_exist/.test(bad2.body.error));
  await writeFile(yamlPath, original);
  check("restored config reloads", (await reload(env.ADMIN_API_TOKEN)).http === 200);

  // --- custom tool through the LLM tool-call loop ----------------------------------------------
  await writeFile(yamlPath, original.replace(/(- name: lookup_order\n\s+enabled: )false/, "$1true"));
  check("reload with lookup_order enabled", (await reload(env.ADMIN_API_TOKEN)).http === 200);
  const c1 = await newCustomer();
  await say(c1.accessToken, c1.roomId, "Where is my order number A-1042? Please check it for me.");
  const answer = await waitFor("AI answer using lookup_order", async () => {
    const ms = await messages(c1.accessToken, c1.roomId);
    return ms.find((m) => m.sender.startsWith("@ai_agent") && m.msgtype === "m.text" && /shipped|ExampleExpress|2 business/i.test(m.body));
  }, 45000);
  check("AI used the custom tool's data in its reply", !!answer, answer?.body.slice(0, 80));
  await writeFile(yamlPath, original);
  await reload(env.ADMIN_API_TOKEN);

  // --- no agent online -> waiting -> fallback --------------------------------------------------
  const alice = await agentLogin("agent_alice", "alice-pass-123");
  const bob = await agentLogin("agent_bob", "bob-pass-123");
  await setPresence(alice.token, false);
  await setPresence(bob.token, false);
  await writeFile(yamlPath, original.replace("fallback_after_seconds: 300", "fallback_after_seconds: 5"));
  await reload(env.ADMIN_API_TOKEN);
  const c2 = await newCustomer();
  await say(c2.accessToken, c2.roomId, "I need to speak to a real person right now about my refund.");
  const w = await waitFor("status waiting", async () => {
    const s = await handoff(c2.accessToken, c2.roomId);
    return s.status === "waiting" && s;
  });
  check("no agent online -> stays 'waiting' (queued)", w.status === "waiting");
  const back = await waitFor("fallback to ai", async () => {
    const s = await handoff(c2.accessToken, c2.roomId);
    return s.status === "ai" && s;
  }, 20000);
  check("fallback timeout returns status to 'ai'", back.status === "ai");
  check("AI got a one-shot note naming the fallback tool", /escalate_via_email/.test(back.ai_note ?? ""));
  const ms2 = await messages(c2.accessToken, c2.roomId);
  check("customer was told nobody is available", ms2.some((m) => /nobody on our team is available/i.test(m.body)));

  // queue pickup: waiting conversation is assigned when an agent comes online
  await writeFile(yamlPath, original.replace("fallback_after_seconds: 300", "fallback_after_seconds: 120"));
  await reload(env.ADMIN_API_TOKEN);
  const c3 = await newCustomer();
  await say(c3.accessToken, c3.roomId, "Please get me a human agent, this is urgent.");
  await waitFor("status waiting (c3)", async () => (await handoff(c3.accessToken, c3.roomId)).status === "waiting");
  await setPresence(bob.token, true);
  const picked = await waitFor("queued conversation assigned when agent comes online", async () => {
    const s = await handoff(c3.accessToken, c3.roomId);
    return s.status === "assigned" && s;
  }, 20000);
  check("waiting queue re-checked when an agent comes online", picked.agent_id === bob.userId, picked.agent_id);
  await setPresence(bob.token, false);
  void json; void sleep;
} finally {
  await writeFile(yamlPath, original);
  await reload(env.ADMIN_API_TOKEN).catch(() => {});
}
