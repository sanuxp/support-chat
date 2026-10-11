# Support Chat v1 — SDLC Document

Living document. Updated at the end of every milestone. Source of truth for requirements: `SUPPORT_CHAT_SPEC.md`.

## 1. Overview
Self-hosted embeddable support chat: customer <-> AI agent (Azure OpenAI), with escalation to a human agent. Built on Matrix (Synapse), text only, no E2EE in v1.

## 2. Requirements
See `SUPPORT_CHAT_SPEC.md` (sections 0-11). Out of scope for v1: E2EE, media, voice/video, compliance, Azure hardening, production TLS.

## 3. Design decisions & deviations from spec
| # | Decision | Reason |
|---|---|---|
| D1 | Project root is `Chat\` (no `support-chat/` subfolder) | User choice |
| D2 | Synapse image pinned to `v1.162.0` | Latest stable tag at build time (checked Docker Hub) |
| D3 | `matrix-bot-sdk` is given a single-namespace (`@customer_.*`) registration object; Synapse's YAML has both namespaces | SDK throws unless exactly one user namespace is supplied (`Appservice.ts` constructor) |
| D4 | `@svc_admin` registered via AS token, then promoted with `UPDATE users SET admin=1` in `init.sh` | Exclusive-namespace users can't use shared-secret registration; DB flag is the documented way |
| D5 | Postgres user is `synapse`, DBs `synapse` + `support_backend`; init SQL creates the second with C collation | Simplest way to satisfy Synapse C-collation requirement |
| D6 | Caddy serves public origin on `:8008`; Synapse also published on `127.0.0.1:8009` for scripts/admin API | Keeps admin API off the public proxy |
| D7 | Backend needs Node >= 22 (matrix-bot-sdk engine); runs in `node:22` image. Host scripts use only Node 20-compatible APIs | Host has Node 20.19 |
| D8 | Added env `ADMIN_API_TOKEN` (spec 7.3.1 needs it but omits it from 5.4) | Protects reload-config |
| D9 | Escalation sync code lives in `routing/handoff.ts` (spec also mentions `routing/escalation.ts`) | Spec layout inconsistency; single place either way |
| D10 | New rooms pinned to room version 11 | Synapse 1.162 defaults to v12 (creator has infinite power and cannot be listed in power_level_users) |
| D11 | Raw HTTP helper (`matrix/synapse.ts`) for impersonation, login and state; `matrix-bot-sdk` handles appservice transactions and the bot intent | Fewer SDK abstractions to verify; AS impersonation via `user_id` is explicit |
| D12 | LLM access uses the plain `openai` client against an OpenAI-compatible LiteLLM proxy (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) instead of `AzureOpenAI` + `AZURE_OPENAI_*` | User supplied a LiteLLM endpoint; chat completions, streaming and tool calls verified against it |
| D13 | Human-agent summary notice (milestone 8) will carry a `com.supportchat.internal: true` content flag; the widget hides such notices | Customer and agent share one room, so an unflagged notice would show the summary to the customer |
| D14 | Widget uses the npm release `matrix-js-sdk` 37.5 (vendor checkout is a newer develop branch) | Real dependencies come from npm per spec |
| D15 | Handoff state gains an optional `ai_note` field (one-shot instruction injected into the AI's next turn, then cleared) | Needed to tell the AI to offer the fallback tool after the waiting timeout; spec's state object had no place for it |
| D16 | When a tool with `after: pause_ai` or `close` succeeds, the core ends the AI turn without another LLM call | Otherwise the model added a duplicate "an agent is joining" message on top of `customer_message` (seen in testing) |
| D17 | Assignment is serialised through one lock and re-checks the conversation is still `waiting` (`routing/agents.ts`) | Race found by the browser test: presence heartbeat's queue pass and the escalation tool both assigned the same room (two summaries) |
| D18 | Agents are auto-registered in the `agents` table on their first authenticated request; availability = `online` flag AND heartbeat within 90 s | Agents are created only via the shared-secret script; a closed tab must not leave an agent "online" forever |
| D19 | `accept` treats "already assigned to me" as success | A queue row can be stale by one poll when the backend assigned it to the same agent |
| D20 | Customer-facing `m.notice` for "nobody available" is a normal notice; agent-only summary is a notice with `com.supportchat.internal: true` (customer widget hides it, agent console highlights it). Note: a customer using the raw Matrix API could still read the summary of their own conversation | Same-room design from the spec |
| D26 | Backend and scripts use asynchronous I/O only (`fs/promises`, async child processes); independent awaits run with `Promise.all` (prompt loading, typing + history, session login + conversation lookup, startup timer re-arming) | Don't block the event loop on the request path; lower latency per AI turn |
| D27 | Host page passes the visitor's name/email/phone/metadata to the widget (`user`, `metadata`, `customHeaders` options) which sends them as `X-Customer-*` headers (URI-encoded) on the session request. Defaults `Test User` / `testuser@test.com` / `+9876543210` (env-overridable). Invalid values are ignored, never an error; missing values keep the stored value | Requested feature; headers are the simplest cross-origin channel from a plain script tag |
| D28 | In `external_jwt` mode verified JWT claims override headers; in `anonymous` mode the values are explicitly **unverified** | Browser headers can be forged; identity-sensitive use needs signed claims |
| D29 | Profile is stored on `customers` (nullable columns + jsonb metadata, defaults applied on read), the Matrix display name is set to the name, and PII is kept out of room state and logs | Agents see names, not ids; avoids plaintext PII in state events (also keeps a later E2EE move simpler) |
| D30 | CORS no longer lists allowed request headers; the browser's requested headers are reflected | Host pages may send arbitrary `customHeaders` |
| D21 | Email and webhook handlers are stubs until milestone 9 | Spec milestone order |
| D22 | SMTP is entirely env-driven (`SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM`); compose no longer hardcodes Mailpit values. TLS is required whenever a user is set. Gmail needs an App Password | User wants Gmail now and other providers later |
| D23 | Escalation recipient comes from `SUPPORT_EMAIL_TO` via `${VAR}` in tools.yaml | Avoid sending test mail to `example.com` when using a real SMTP account |
| D24 | Delete uses Delete Room v2 with `purge: true, block: true`, polls delete_status up to 10 s, and marks `deleted_at` in `conversations` after success; 502 if Synapse reports failure, 202 if still running | Matches spec 7.5; `block` stops anyone rejoining the purged room |
| D25 | Email handler logs only error class/code, never error text; webhook handler logs only HTTP status/reason | Error strings can echo addresses or content |

## 4. Milestone tracker
| # | Milestone | Status | Verified by |
|---|---|---|---|
| 1 | Scaffold (repos, layout, env, init.sh, Postgres+Synapse) | Done | `/_matrix/client/versions` OK; C collation; `@svc_admin` admin |
| 2 | Appservice | Done | Backend boots; `@ai_agent` and `@svc_admin` exist in Synapse; room created as ai_agent |
| 3 | Customer session | Done | `scripts/session-test.mjs`: session OK, customer message sent (200), customer state write denied (403), same visitorId gives same room |
| 4 | AI replies | Done | `scripts/ai-test.mjs`: reply in ~3.9 s, streamed then finalised via m.replace edit; backend logs contain ids/timings/token counts only |
| 5 | Widget | Done | Headless Edge test: bubble opens, message sent, streamed AI reply shown, host CSS does not leak (Shadow DOM), history survives reload. Delete button UI is wired; backend endpoint lands in milestone 10 |
| 6 | Agents | Done | `create-agent.ts` creates `@agent_*` accounts; Agent UI login, online toggle (30 s heartbeat), queue, conversation view built; `scripts/ui-e2e.mjs` drives it in headless Edge (8 checks pass) |
| 7 | Tool system | Done | `scripts/e2e-tools.ts` (13 checks): reload endpoint auth (401/401/200), invalid yaml rejected with entry pointer, unknown `fallback_tool` rejected, custom `lookup_order` used by the LLM; backend refuses to start on bad yaml with a clear error (checked manually via `docker compose run`) |
| 8 | Human chat escalation | Done | `scripts/e2e-escalation.ts` (15 checks): waiting -> assigned, summary stored, agent reads earlier history, exactly one agent-only summary, agent <-> customer messages, AI silent while assigned, resolve returns to AI; `e2e-tools.ts`: queue, fallback timeout with AI note, queued chat assigned when an agent comes online |
| 9 | Email + webhook | Done | Smoke steps 7-8: email lands in Mailpit with summary, customer address and transcript, status `escalated_external`, AI keeps replying; webhook sent to a local echo server with a valid HMAC signature, env-resolved header, payload fields, and the response reached the LLM (AI quoted the ticket id). Gmail SMTP not tested (no credentials); same code path with different env values |
| 10 | Delete conversation | Done | Smoke step 10 + browser test: owner delete 200, other customer 404, admin API returns 404 for the room, new session creates a new room; widget Delete works cross-origin (DELETE added to CORS) |
| 11 | Smoke test + README | Done | `npm run smoke-test`: all 11 steps pass (SMOKE TEST PASSED). `README.md` written |

## 5. Testing
Acceptance = `scripts/smoke-test.ts` (spec section 10). Per-milestone checks are recorded in the tracker.

## 6. Risks / open items
- Azure OpenAI creds must be put in `.env` by the user before milestone 4.
- Known issue: `widget.js` is ~8.5 MB (~2.9 MB gzipped) because matrix-js-sdk bundles its crypto WASM even with E2EE off. Options later: split crypto into a lazy chunk, or serve the bundle with compression.
- Known issue: the AI invented opening hours in the first test. `config/prompts/system.md` should be given real company facts, or a "don't guess" rule strengthened, before real use.
- Open: Gmail SMTP path is untested until credentials are in `.env`. If it fails, check the App Password and that `SMTP_FROM` equals the account.
- Open: model-dependent behaviour (whether the AI calls a tool, quotes a result) makes the LLM-driven smoke steps slightly non-deterministic; steps retry or phrase requests explicitly to limit this.
- Test hygiene: e2e scripts close leftover waiting/assigned conversations at start (`resetQueue()` uses `docker compose exec postgres`), because unresolved chats fill an agent's `max_concurrent` (3). Browser test also needs `playwright-core` and Edge.
- Test accounts created locally: `agent_alice` / `alice-pass-123`, `agent_bob` / `bob-pass-123` (dev only).
- Timers for the waiting fallback are in memory; on restart they are re-armed from the room state (`routing/startup.ts`).
- Custom tool modules are cached by Node after first import; editing `tools/custom/*.ts` needs a restart (yaml and prompts reload without one).
- Secrets hygiene: `.env.example` must only hold dummy values. A real API key was found in it once and replaced.
- Logging rule: no message bodies or tool args in logs (verified in smoke test step 11).

## 7. Change log
- 2026-10-12: Milestone 1 completed; document created.
- 2026-10-12: Milestones 2-3 completed (appservice, customer session).
- 2026-10-13: Customer profile from the host page (D27-D30): widget options, backend validation/storage/defaults, AI prompt + tool template variables + webhook payload, agent console customer card, `npm run e2e:profile` (12 checks pass) and a browser check; docs updated.
- 2026-10-12: Async refactor (D26, smoke test re-run: passed). Documentation added: `docs/DEVELOPER_GUIDE.md` plus README in backend, widget, agent-ui, scripts and synapse.
- 2026-10-12: Milestones 9-11 completed (email + webhook handlers, customer delete, smoke test, README). Env-driven SMTP for Gmail (D22). v1 feature-complete; smoke test passes.
- 2026-10-12: Milestones 6-8 completed (agents + Agent UI, tool system, human-chat escalation). Fixed: duplicate assignment race, widget "Agent joined" detection, empty-JSON-body rejection, duplicate AI text after pause_ai tools.
- 2026-10-12: Switched LLM config to LiteLLM (D12). Milestones 4-5 completed (AI replies, widget). `.env.example` filled with dummy values.
