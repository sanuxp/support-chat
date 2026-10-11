// Shared helpers for host-side test scripts (Node 20+, fetch only).
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.js";

export const env = await loadEnv();
export const API = process.env.API ?? "http://localhost:8008"; // via Caddy
export const HS = process.env.HS ?? "http://localhost:8008";
export const enc = encodeURIComponent;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function json(method: string, url: string, token?: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...extraHeaders, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  return { ...data, _http: res.status }; // _http = HTTP status (response bodies may have their own `status` field)
}

export interface Customer {
  userId: string; accessToken: string; roomId: string; backendToken: string; visitorId: string;
  profile: { name: string; email: string; phone: string };
}

/** Create a customer session. `headers` simulates what the widget sends (X-Customer-Name, ...; values URI-encoded). */
export async function newCustomer(visitorId?: string, headers: Record<string, string> = {}): Promise<Customer> {
  const s = await json("POST", `${API}/api/customer/session`, undefined, visitorId ? { visitorId } : {}, headers);
  if (s._http !== 200) throw new Error(`session failed: ${s._http}`);
  return s as Customer;
}

export const say = (token: string, roomId: string, body: string) =>
  json("PUT", `${HS}/_matrix/client/v3/rooms/${enc(roomId)}/send/m.room.message/${Date.now()}-${Math.random()}`, token, { msgtype: "m.text", body });

export const handoff = (token: string, roomId: string) =>
  json("GET", `${HS}/_matrix/client/v3/rooms/${enc(roomId)}/state/com.supportchat.handoff/`, token);

export interface Msg { sender: string; body: string; msgtype: string; eventId: string; internal: boolean; ts: number }

/** Messages (newest last) with edits applied. */
export async function messages(token: string, roomId: string, limit = 50): Promise<Msg[]> {
  const r = await json("GET", `${HS}/_matrix/client/v3/rooms/${enc(roomId)}/messages?dir=b&limit=${limit}`, token);
  const out: Msg[] = [];
  for (const ev of r.chunk ?? []) {
    if (ev.type !== "m.room.message" || ev.content?.["m.relates_to"]?.rel_type === "m.replace") continue;
    const edit = ev.unsigned?.["m.relations"]?.["m.replace"]?.content?.["m.new_content"];
    const c = edit ?? ev.content;
    out.push({ sender: ev.sender, body: c.body, msgtype: c.msgtype, eventId: ev.event_id, internal: !!ev.content?.["com.supportchat.internal"], ts: ev.origin_server_ts });
  }
  return out.reverse();
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 45000, everyMs = 700): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for: ${what}`);
}

export async function agentLogin(name: string, password: string): Promise<{ token: string; userId: string }> {
  const r = await json("POST", `${HS}/_matrix/client/v3/login`, undefined, {
    type: "m.login.password", identifier: { type: "m.id.user", user: name }, password,
  });
  if (!r.access_token) throw new Error(`agent login failed (${r._http} ${r.errcode})`);
  return { token: r.access_token, userId: r.user_id };
}

export const setPresence = (token: string, online: boolean) => json("POST", `${API}/api/agent/presence`, token, { online });

export function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

/** Run a command without blocking; never throws on a non-zero exit (check `code`). */
export async function run(
  cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; out: string }> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      cmd, args,
      { cwd: opts.cwd, encoding: "utf8", timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, out: String(stdout) + String(stderr) }),
    );
  });
}

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Test hygiene: close any leftover waiting/assigned conversations so agent capacity/queue start clean. */
export async function resetQueue(): Promise<void> {
  await run(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "synapse", "-d", "support_backend", "-c",
     "UPDATE conversations SET status='closed' WHERE status IN ('waiting','assigned')"],
    { cwd: repoRoot },
  );
}
