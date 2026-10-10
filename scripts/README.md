# scripts — setup, utilities and tests

Run from the **repo root** (`npm install` once there). Host requirements: Node 20+, Docker, Git Bash for `*.sh`.

| Script | Run with | What it does |
|---|---|---|
| `init.sh` | `bash scripts/init.sh` | First-run setup: creates `.env` from `.env.example`, generates random secrets for empty "auto" values, renders `synapse/*.template` into `data/synapse/`, starts Postgres + Synapse, waits for health, registers `@svc_admin` through the appservice token and promotes it to server admin (SQL `UPDATE users SET admin=1`). Safe to re-run |
| `create-agent.ts` | `npm run create-agent -- <name> <password> [display name]` | Creates `@agent_<name>` via Synapse's shared-secret registration API (HMAC-SHA1 over nonce/user/password/"notadmin"). Prints "already exists" if present |
| `smoke-test.ts` | `npm run smoke-test` | **The acceptance test** (spec section 10): 11 steps, ~3 min, real LLM. Prints PASS/FAIL per check and `SMOKE TEST PASSED/FAILED` |
| `e2e-escalation.ts` | `npm run e2e:escalation` | Human hand-off flow only (15 checks) |
| `e2e-tools.ts` | `npm run e2e:tools` | `reload-config` auth + validation, custom tool through the LLM, queue, fallback timeout, queue pickup (13 checks) |
| `ui-e2e.mjs` | `npm run e2e:ui` | Browser test with Playwright + Microsoft Edge: agent signs in and goes online, customer asks for a human in the widget, agent takes it, replies, resolves |
| `echo-server.ts` | `npx tsx scripts/echo-server.ts` | Local webhook receiver on :4010 that verifies the HMAC signature and returns a fake ticket. Also imported by the smoke test |
| `lib.ts` | (library) | Test helpers: `json`, `newCustomer`, `say`, `messages` (edits applied), `handoff`, `waitFor`, `agentLogin`, `setPresence`, `check`, `run` (async child process), `resetQueue` |
| `env.ts` | (library) | Async `.env` reader for host scripts (handles inline comments/quotes) |
| `session-test.mjs`, `ai-test.mjs` | `node scripts/<file>` | Early milestone checks (session + permissions, first AI reply). Kept as quick manual probes |

## What the smoke test does (and changes)

1. Creates `agent_alice` (password `alice-pass-123`) if missing, and **closes leftover waiting/assigned conversations** in the DB (`resetQueue`).
2. Walks the 11 spec steps: session → AI reply → human escalation → agent message → AI silent → resolve to AI → email (Mailpit verified when `SMTP_HOST=mailpit`) → webhook (echo server, signature, env header, response reaches the model) → broken `tools.yaml` refuses to start → delete conversation (admin API confirms the room is gone) → logs contain no marker strings.
3. **Temporarily edits `backend/config/tools.yaml`** and restores it in a `finally`. If a run is killed mid-way, compare that file with the example in the root README (this project is not under git yet).

Tips:
- LLM-dependent steps can occasionally fail on model wording. Re-run before assuming a regression; look at the failing line and `docker compose logs backend`.
- Unresolved test conversations fill an agent's `max_concurrent`. `resetQueue` handles this automatically; if you chat manually as an agent, resolve your chats.
- The scripts use `docker compose exec/run/logs` (via the async `run` helper) — Docker must be on PATH.
- Test data (customers, rooms) is left in the database; use `docker compose down -v && rm -rf data && bash scripts/init.sh` for a clean slate.

## Writing a new test

Import helpers from `./lib.js`, use `check(label, boolean, detail?)` (sets a non-zero exit code on failure), and `waitFor(what, fn, timeoutMs)` for anything asynchronous. Remember `json()` returns the response body plus `_http` (the HTTP status) — response bodies may contain their own `status` field, so never rely on `.status`.
