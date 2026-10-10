// Create a human agent account (a normal password user, not an appservice user).
// Usage: npm run create-agent -- <name> <password> [display name]
//   <name> becomes @agent_<name>:<server>. Uses Synapse's shared-secret registration API.
import { createHmac } from "node:crypto";
import { loadEnv } from "./env.js";

export async function createAgent(name: string, password: string, displayName?: string) {
  const env = await loadEnv();
  const base = env.SYNAPSE_ADMIN_URL ?? "http://localhost:8009"; // Synapse published on localhost only
  const username = name.startsWith("agent_") ? name : `agent_${name}`;
  const secret = env.SYNAPSE_REGISTRATION_SHARED_SECRET;
  if (!secret) throw new Error("SYNAPSE_REGISTRATION_SHARED_SECRET missing (run scripts/init.sh)");

  const { nonce } = (await (await fetch(`${base}/_synapse/admin/v1/register`)).json()) as { nonce: string };
  // MAC = HMAC-SHA1(secret, nonce \0 username \0 password \0 "notadmin")
  const mac = createHmac("sha1", secret).update(`${nonce}\0${username}\0${password}\0notadmin`).digest("hex");
  const res = await fetch(`${base}/_synapse/admin/v1/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, username, password, admin: false, displayname: displayName ?? name, mac }),
  });
  const body: any = await res.json();
  if (!res.ok) {
    if (body.errcode === "M_USER_IN_USE") return { userId: `@${username}:${env.MATRIX_SERVER_NAME}`, existed: true };
    throw new Error(`register failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { userId: body.user_id as string, existed: false };
}

if (process.argv[1]?.endsWith("create-agent.ts")) {
  const [name, password, display] = process.argv.slice(2);
  if (!name || !password) {
    console.error("usage: npm run create-agent -- <name> <password> [display name]");
    process.exit(1);
  }
  createAgent(name, password, display)
    .then((r) => console.log(r.existed ? `already exists: ${r.userId}` : `created ${r.userId}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
