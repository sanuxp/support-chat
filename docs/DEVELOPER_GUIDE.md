# Support Chat — Developer Guide

For engineers new to this project. Read this once, front to back (about 30 minutes), then keep it open as a reference. Each sub-project also has its own README with module-level detail:

| Read next | When |
|---|---|
| [`../README.md`](../README.md) | Setting up and running it; env var reference |
| [`../backend/README.md`](../backend/README.md) | Working on the Node service |
| [`../widget/README.md`](../widget/README.md) | Working on the customer chat widget |
| [`../agent-ui/README.md`](../agent-ui/README.md) | Working on the human-agent console |
| [`../scripts/README.md`](../scripts/README.md) | Setup scripts and the test suites |
| [`../synapse/README.md`](../synapse/README.md) | Infrastructure: Synapse, Postgres, Caddy, Docker |
| [`../SDLC.md`](../SDLC.md) | Why things are the way they are (decision log D1–D25), test evidence, open risks |
| [`../SUPPORT_CHAT_SPEC.md`](../SUPPORT_CHAT_SPEC.md) | The original requirements |

---

## 1. What this product does

A website owner embeds a chat bubble. A **customer** types a question. An **AI agent** (an LLM) answers. If the customer needs a person — or the AI decides they do — the AI **escalates**, and a **human support agent** joins *the same conversation* from a separate console. The human can hand it back to the AI or close it. The AI can also act through **tools**: email the support team, call a webhook (e.g. create a ticket), or run custom code (e.g. look up an order).

Everything runs on your own infrastructure. v1 is **text only, no end-to-end encryption, federation off**. The code is structured so encryption and voice/video can be added later.

## 2. A 5-minute Matrix primer

The chat transport is **Matrix**, an open protocol. You don't need to be an expert, but these terms are used everywhere:

| Term | Meaning here |
|---|---|
| **Homeserver (Synapse)** | The Matrix server. Stores rooms/messages, authenticates users. We run it in Docker. |
| **Room** | A conversation. **One room per customer conversation.** Members: the customer, the AI user, and (later) one human agent. |
| **Event** | A thing that happened in a room: a message, a join, a state change. Messages are `m.room.message` events. |
| **State event** | An event that sets a piece of room *state* (name, membership, power levels, and our custom hand-off data). Identified by `type` + `state_key`. |
| **User ID (mxid)** | `@localpart:server`, e.g. `@customer_1b2c…:chat.local`, `@ai_agent:chat.local`, `@agent_alice:chat.local`. |
| **Access token** | What a client sends to act as a user. Customers and agents get their own tokens. |
| **Power level** | Per-user permission number in a room. 0 = can chat; 100 = can change state, invite, kick. |
| **Edit (`m.replace`)** | Matrix messages are immutable; an "edit" is a new event pointing at the original. We use edits to stream the AI's answer as it is generated. |
| **Application service (appservice)** | A trusted backend registered with Synapse. It owns a namespace of users (`@customer_*`, `@svc_admin`, plus the sender `@ai_agent`) and may act as them. This is how our backend creates customer users and logs them in without passwords. |
| **`sync`** | How Matrix clients stay up to date (long-poll). `matrix-js-sdk` hides it. |

Our users and who they are:

| User | Created by | Logs in with | Power level in rooms |
|---|---|---|---|
| `@customer_<uuid>` | Backend via appservice | Backend issues a token (`m.login.application_service`) | 0 |
| `@ai_agent` | Backend (appservice sender) | Appservice token | 100 |
| `@svc_admin` | `scripts/init.sh` | Backend issues a token on demand | 100, and a Synapse **server admin** (can purge rooms) |
| `@agent_<name>` | `npm run create-agent` | Username + password (normal Matrix login) | 0 |

## 3. Architecture

```
 Browser A: customer site            Browser B: human agent
 ┌────────────────────────┐          ┌────────────────────────┐
 │ widget.js (Shadow DOM) │          │ Agent console (React)  │
 │ matrix-js-sdk          │          │ matrix-js-sdk          │
 └───────────┬────────────┘          └───────────┬────────────┘
             │  Matrix client-server API + our REST API (/api/*)
             ▼
     ┌─────────────────────────────  Caddy :8008  ──────────────────────────────┐
     │  /_matrix/*  → Synapse      /api/*  → Backend      /agent/* , /  → static │
     └──────┬───────────────────────────────┬───────────────────────────────────┘
            ▼                               ▼
   ┌──────────────────┐   appservice   ┌────────────────────────────────────────┐
   │ Synapse          │◄──────────────►│ Backend (Node 22, TypeScript)          │
   │  federation OFF  │  transactions  │  • appservice (receives room events)   │
   │  registration OFF│  + client API  │  • AI agent + tool-call loop           │
   └────────┬─────────┘                │  • routing / hand-off / queue          │
            ▼                          │  • REST API (customer, agent, admin)   │
   ┌──────────────────┐                └────┬──────────────┬───────────────┬────┘
   │ Postgres 16      │◄── support_backend ─┘              │               │
   │  DBs: synapse,   │                                    ▼               ▼
   │  support_backend │                         LLM (OpenAI-compatible,   SMTP server
   └──────────────────┘                         e.g. LiteLLM)              (Mailpit/Gmail)
                                                                           + your webhooks
```

### Services and ports (local)

| Service | Container | Reachable at | Notes |
|---|---|---|---|
| Caddy | `caddy` | `http://localhost:8008` | The only public entry point. Homeserver URL for browsers. |
| Synapse | `synapse` | `127.0.0.1:8009` (host only) | Direct access for scripts/admin API. Not behind Caddy on purpose. |
| Backend REST | `backend` | `127.0.0.1:3000`, and `/api/*` via Caddy | |
| Backend appservice | `backend` | `backend:9000` (Docker network only) | Synapse pushes room events here. |
| Postgres | `postgres` | Docker network only | C collation (Synapse requirement). |
| Mailpit | `mailpit` | `http://localhost:8025` (web), `1025` (SMTP) | Fake inbox for dev. |

## 4. Repository map

```
Chat/
├── docker-compose.yml          # postgres, synapse, backend, caddy, mailpit
├── .env / .env.example         # all secrets and settings (.env is gitignored)
├── README.md                   # setup + env reference
├── SDLC.md                     # decision log, milestone evidence, risks
├── SUPPORT_CHAT_SPEC.md        # original requirements
├── docs/DEVELOPER_GUIDE.md     # this file
├── backend/                    # Node service   → backend/README.md
│   ├── config/                 #   tools.yaml + prompts/*.md  (edit without code changes)
│   └── src/                    #   ai/ api/ db/ matrix/ routing/ tools/
├── widget/                     # customer widget → widget/README.md
├── agent-ui/                   # agent console   → agent-ui/README.md
├── scripts/                    # init, create-agent, tests → scripts/README.md
├── synapse/ caddy/ postgres/   # infra configs   → synapse/README.md
├── data/                       # generated Synapse config + media + keys (gitignored)
└── vendor/                     # cloned reference repos — read only, never modified, gitignored
```

> **Version control:** this folder is not a git repository yet. Run `git init` (the `.gitignore` already excludes `.env`, `data/`, `vendor/`, `node_modules/`, `dist/`) before sharing the code, and never commit `.env`.

`vendor/` holds the Synapse, `matrix-js-sdk` and `matrix-bot-sdk` sources. They exist **only to read** when an API is unclear (this project's rule: check library APIs against source, don't trust memory). Real dependencies come from npm and Docker images.

## 5. Data model

### 5.1 Matrix room state (the source of truth)

Created by `backend/src/matrix/rooms.ts → createConversationRoom`:

- Room version **11**, preset `private_chat`, `history_visibility: shared` (a human who joins later can read earlier messages), **no** encryption event.
- Power levels: `@ai_agent` and `@svc_admin` = 100, everyone else 0. `state_default` = 100, so **customers and agents cannot change state directly** — only the backend can. Invite/kick/ban = 100.

Custom state events (state key `""`):

`com.supportchat.handoff` — who is handling this conversation:

```json
{
  "status": "ai",              // ai | waiting | assigned | escalated_external | closed   ("resolved" exists in the type but is not currently set)
  "agent_id": null,            // "@agent_alice:chat.local" when assigned
  "channel": null,             // tool that escalated, e.g. "escalate_to_human_chat"
  "reason": null,              // why (written by the AI)
  "summary": null,             // AI-written summary for the human
  "ai_note": null,             // one-shot instruction injected into the AI's next turn, then cleared
  "updated_at": 1791807082750
}
```

`com.supportchat.conversation` — `{ "customer_ref": "anon:<visitorId>" | "ext:<sub>", "created_at": … }`.

Message content flags: a notice with `"com.supportchat.internal": true` is **agent-only** (the AI summary). The widget hides it; the agent console highlights it.

### 5.2 Postgres `support_backend` (an index, not the truth)

| Table | Columns | Purpose |
|---|---|---|
| `customers` | `id uuid`, `external_ref` (unique), `matrix_user_id` (unique) | Maps a visitor / external user to a Matrix user |
| `conversations` | `id`, `customer_id`, `room_id` (unique), `status`, `assigned_agent`, `created_at`, `updated_at`, `deleted_at` | Fast queries for routing and the agent queue |
| `agents` | `matrix_user_id`, `display_name`, `max_concurrent` (3), `online`, `last_seen` | Presence and capacity |

**Rule:** Matrix state is authoritative; the `conversations` table mirrors it. They are updated together in exactly one place — `routing/handoff.ts → updateHandoff`. Never write `status` or `assigned_agent` anywhere else.

### 5.3 Hand-off status machine

```
              customer asks for human / AI calls escalate_to_human_chat
   ai ───────────────────────────────────────────────► waiting ──(agent free)──► assigned
    ▲                                                     │                          │
    │            fallback timeout (default 300 s)         │            resolve(returnToAi=true)
    └─────────────────────────────────────────────────────┘◄─────────────────────────┤
    ▲                                                                                │ resolve(returnToAi=false)
    │   email tool succeeded (escalated_external; AI keeps talking if after=continue_ai)     ▼
    └────────────────────────────────────── ai ◄── ·  ·  ·                          closed
```

The AI may reply only when status is `ai`, or `escalated_external` **and** that tool's `after` is `continue_ai` (`ai/agent.ts → aiMayReply`).

## 6. How the important things work

### 6.1 Customer session — `POST /api/customer/session` (`api/customer.ts`)

1. Identify the customer: `anonymous` mode uses a `visitorId` from the widget's `localStorage` (a UUID; generated if missing); `external_jwt` mode verifies a host-app JWT with `EXTERNAL_JWT_PUBLIC_KEY` and uses `sub`. *(The JWT mode is implemented but not covered by the automated tests.)*
2. Upsert the `customers` row; ensure the Matrix user `@customer_<uuid>` exists (appservice registration).
3. Obtain a Matrix access token with `m.login.application_service` (`matrix/users.ts`) — no password involved — while looking up the customer's open conversation in parallel.
4. If there is no open conversation, create a room (§5.1), invite and join the customer.
5. Return `{ homeserverUrl, userId, accessToken, deviceId, roomId, backendToken, visitorId }`. `backendToken` is a 12-hour JWT for the backend's own REST endpoints.

The widget then talks **directly to Synapse** with the access token (sending/receiving messages), and to the backend only for session and delete.

### 6.2 The AI replies (`ai/agent.ts`)

Synapse pushes every room event to the backend's appservice endpoint; `matrix-bot-sdk` emits `room.message`. For each customer text message:

1. Ignore anything not from `@customer_*` or not `m.text`. Messages in one room are processed **one at a time** (per-room promise queue).
2. Read the hand-off state; stop unless `aiMayReply`.
3. In parallel: send typing indicator, load the last `AI_HISTORY_MESSAGES` messages (edits applied), build the system prompt from `config/prompts` (async file reads).
4. Map history to LLM roles: customer → `user`, `@ai_agent` → `assistant`, human agent → `user` prefixed `[Human agent]`; skip `m.notice`. If `handoff.ai_note` is set, add it as a system message.
5. Call the LLM (`ai/llm.ts`, streaming chat completions — stateless, no threads).
6. **Stream to Matrix** (`ai/streaming.ts`): first chunk is sent as a new message, then updated with `m.replace` edits at most once per `AI_STREAM_EDIT_INTERVAL_MS`, plus a final edit.
7. **Tool-call loop:** if the model calls tools, run them (§6.3), append results, call the model again — up to `max_tool_rounds`. If a tool has `after: pause_ai` or `close`, the turn **ends immediately** (otherwise the model adds a duplicate "an agent is joining" message).
8. Errors → a polite `m.notice` to the customer; the log gets only the error class/status, never content.

### 6.3 Tools (`tools/`) — config-driven, no code changes for new tools

`backend/config/tools.yaml` defines every action the AI can take. `tools/registry.ts` loads and validates it (zod + ajv), resolves `${ENV_VAR}` in `options`, and exposes enabled tools to the LLM as function definitions.

When the model calls a tool, `executeTool`:

1. Parses and validates the arguments against the tool's JSON Schema (errors list property paths only, never values).
2. Builds a `ToolContext` (room id, customer ref, transcript access, hand-off get/set, resolved options, a content-free logger).
3. Runs the handler: `human_chat`, `email`, `webhook`, or a `custom` module.
4. **Core, not the handler,** then posts the tool's `customer_message` (templated with `{{args}}`) and applies `after` (`pause_ai` → ensure AI paused, `continue_ai` → nothing, `close` → status `closed`).
5. Returns the handler's `llmResult` to the model.

Config can be reloaded at runtime (`POST /api/admin/reload-config`); an invalid file is rejected with the exact entry and the old config stays active. At startup an invalid file stops the process.

### 6.4 Human escalation (`tools/handlers/humanChat.ts`, `routing/`)

1. Set hand-off `waiting` (with channel, reason, summary).
2. `assignToBestAgent`: pick an agent who is **online** (heartbeat within 90 s), has fewer than `max_concurrent` active conversations, fewest first. If found: invite them, set `assigned`, post the agent-only summary notice.
3. If nobody is free: stay `waiting`, arm a **fallback timer** (`fallback_after_seconds`). When it fires and the chat is still waiting: tell the customer, set status back to `ai`, set `ai_note` telling the AI to offer the fallback tool (e.g. email) and collect what it needs first.
4. Whenever an agent comes online or resolves a chat, `processQueue` re-checks waiting conversations (oldest first).
5. The agent console accepts (`/accept`), then joins the room with its own Matrix client and chats normally. **The AI stays silent** while status is `assigned`.
6. Resolve: the backend kicks the agent from the room and either returns to `ai` ("You're chatting with our AI assistant again.") or `closed` ("This conversation has ended.").

**Concurrency rule:** all assignment goes through one lock in `routing/agents.ts` (`exclusive`) and re-checks the room is still `waiting`. Without it, the escalation tool and the presence heartbeat's queue pass could both assign the same room (this bug happened; see SDLC D17). Fallback timers are in-memory and re-armed from room state on restart (`routing/startup.ts`).

### 6.5 Email and webhook tools

- **Email** (`handlers/email.ts`): `nodemailer` over SMTP configured only by env (`SMTP_*`). Renders subject/body templates, includes the transcript if configured, sets `reply-to` to the customer. Status becomes `escalated_external` **only after a successful send**.
- **Webhook** (`handlers/webhook.ts`): POSTs `{tool, args, room_id, customer_ref, transcript?}` with `X-SupportChat-Signature: sha256=<HMAC-SHA256(raw body, WEBHOOK_SIGNING_SECRET)>`; timeout via `AbortController`; optional response (≤ 4 KB) is returned to the model.

### 6.6 Customer deletes a conversation (`DELETE /api/customer/conversations/:roomId`)

The caller must own the room (checked in Postgres → otherwise 404). The backend logs in as `@svc_admin` (appservice login, cached) and calls Synapse's **Delete Room v2** API with `purge: true, block: true`, polls `delete_status` for up to 10 s, then sets `deleted_at`. The widget then starts a fresh session → new room.

## 7. Backend REST API

All JSON. Browsers reach it through Caddy at `/api/*`.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | Liveness |
| `POST /api/customer/session` | none (anonymous) or host-app JWT | Create/resume session (§6.1) |
| `DELETE /api/customer/conversations/:roomId` | `Bearer <backendToken>` | Delete own conversation |
| `POST /api/agent/presence` `{online}` | `Bearer <agent Matrix token>` | Online/offline + heartbeat |
| `GET /api/agent/conversations` | agent token | My assigned + waiting conversations |
| `POST /api/agent/conversations/:roomId/accept` | agent token | Take a waiting chat / re-invite myself |
| `POST /api/agent/conversations/:roomId/resolve` `{returnToAi}` | agent token | Hand back to AI (default) or close |
| `POST /api/admin/reload-config` | `Bearer <ADMIN_API_TOKEN>` | Reload `tools.yaml` + prompts |

Agent auth: the token is verified with Synapse `GET /account/whoami` (cached 30 s); the user must be `@agent_*`.

## 8. Security and privacy model

- **No secrets in code.** Everything in `.env` (gitignored); `.env.example` holds only dummy values. `init.sh` generates random secrets.
- **Customers** hold a Matrix token limited to their own room and a short-lived backend JWT. They cannot change hand-off state (power levels).
- **Agents** are normal password accounts, created only by someone with the Synapse shared secret. Only `@agent_*` users are accepted by the agent API.
- **Admin API exposure:** Synapse's admin API is not behind Caddy; it is reachable only on `127.0.0.1:8009`.
- **Logging rule (important):** never log message bodies, LLM prompts/responses, tool arguments, or email addresses. Log ids, tool names, timings, token counts, and error *classes*. The smoke test greps the logs for unique marker strings to enforce this. When adding code, follow it — including in `catch` blocks (error text can echo content).
- **Known limitation:** the agent-only summary lives in the shared room. A customer using the raw Matrix API could read it. See SDLC D20.
- **Webhook authenticity:** receivers must verify `X-SupportChat-Signature` against the raw body.

## 9. Local development workflow

```bash
bash scripts/init.sh                                   # once
(cd widget && npm i && npm run build); (cd agent-ui && npm i && npm run build)
docker compose up -d --build
npm i && npm run create-agent -- alice 'password' 'Alice'
```

Daily loop:

| I changed… | Do |
|---|---|
| Backend code | `docker compose up -d --build backend` then `docker compose logs -f backend` |
| `tools.yaml` / `prompts/*.md` | `curl -X POST localhost:8008/api/admin/reload-config -H "Authorization: Bearer $ADMIN_API_TOKEN"` (no restart) |
| Widget / agent-ui | `npm run dev` in that folder (hot reload), or rebuild (`npm run build`) — Caddy serves `dist/` straight from disk |
| `.env` | `docker compose up -d backend` (recreates with new env) |
| Synapse template | re-run `bash scripts/init.sh`, then `docker compose restart synapse` |

Useful commands:

```bash
# peek at the database
docker compose exec postgres psql -U synapse -d support_backend -c "select room_id,status,assigned_agent from conversations order by created_at desc limit 5"
# read a room's messages as the AI user (appservice token), e.g. when debugging a conversation
curl -s "http://localhost:8009/_matrix/client/v3/rooms/<urlencoded room id>/messages?dir=b&limit=20" -H "Authorization: Bearer $AS_TOKEN"
# the current hand-off state of a room
curl -s "http://localhost:8009/_matrix/client/v3/rooms/<urlencoded room id>/state/com.supportchat.handoff/" -H "Authorization: Bearer $AS_TOKEN"
```

**Windows notes:** use Git Bash for `*.sh`; `.gitattributes` forces LF line endings for shell scripts and templates. From the backend container, the host is `host.docker.internal` (used by the webhook test).

## 10. Testing

| Command | Covers |
|---|---|
| `npm run smoke-test` | The full acceptance test (spec §10): all 11 steps against the real stack and LLM, ~3 min |
| `npm run e2e:escalation` | Human hand-off flow (15 checks) |
| `npm run e2e:tools` | Reload auth, config validation, custom tool, queue, fallback (13 checks) |
| `npm run e2e:ui` | Browser test: customer widget + agent console in headless Edge |

Notes: tests call the real LLM, so LLM-dependent steps can occasionally be flaky; the scripts phrase requests explicitly and retry where sensible. They temporarily edit `backend/config/tools.yaml` (restored in `finally`) and close leftover waiting/assigned conversations first — **unresolved test chats fill an agent's `max_concurrent`** and make later runs hang in the queue.

## 11. Conventions

- **TypeScript everywhere**, strict mode. ESM (`"type": "module"`); backend imports use `.js` suffixes (NodeNext).
- **Async I/O only** in the backend and scripts: `fs/promises`, async child processes, `await` — no `*Sync` calls on request paths. Run independent awaits together with `Promise.all` (see `ai/agent.ts`, `ai/prompt.ts`, `api/customer.ts`).
- **State changes in one place:** hand-off → `routing/handoff.ts`; assignment → `routing/agents.ts`.
- **Configuration over code:** new tools/prompts go in `backend/config/`. Add a TypeScript handler only when no built-in handler fits.
- **Matrix calls** go through `matrix/synapse.ts` (`synapse(method, path, {token, actAs, body})`). `matrix-bot-sdk` is used only to receive appservice events and register the bot user.
- **Errors:** handlers return `{ ok:false, llmResult:{error:"safe message"} }` rather than throwing; the model explains the failure to the customer. Never put raw error text in `llmResult` or logs.
- **No hardcoded secrets or URLs**; add new settings to `.env.example` (with a dummy value) and the README table.

### How to add things

- **A new tool using existing handlers:** edit `tools.yaml` + a prompt file (worked example in the root README).
- **A new custom tool:** `backend/src/tools/custom/<name>.ts` default-exporting a `ToolHandler`; see `example.ts`; reference with `handler: custom, module: <name>`; restart the backend.
- **A new built-in handler type:** add `handlers/<x>.ts`, add the name to the enum in `tools/registry.ts` (`ToolSchema`) and to the handler selection in `build()`.
- **A new REST endpoint:** add to a file in `api/`, register in `api/server.ts`; authenticate with `verifyBackendToken` (customer) or `authenticateAgent` (agent).
- **A new hand-off status:** extend `HandoffStatus` in `matrix/rooms.ts`, update `aiMayReply`, the widget/console rendering, and the status diagram above.

## 12. Gotchas we already paid for

| Symptom / trap | Cause and rule |
|---|---|
| `createRoom` power levels rejected | Synapse 1.162 defaults to room v12 (creator has infinite power, can't be listed in `power_level_users`). We pin **v11**. |
| `matrix-bot-sdk` throws on start | It accepts exactly **one** user namespace; we give it a single-namespace view. Synapse's real registration YAML has both. |
| Exclusive-namespace user can't use shared-secret registration | `@svc_admin` is registered via the appservice token, then promoted with SQL in `init.sh`. |
| Agent clicks a queue row and gets 409 | Row was stale by one poll; `accept` now treats "already assigned to me" as success. |
| Two summaries in a new conversation | Assignment race (heartbeat vs tool) — fixed with the lock. |
| `400 Body cannot be empty` on POSTs | Fastify rejects empty JSON bodies; a custom parser accepts them. |
| Widget Delete fails in the browser only | CORS defaults omit `DELETE`; now allowed explicitly. |
| "Agent joined" never shown | A join after an invite has `prev_content.membership = invite`; check `!== "join"`. |
| AI adds a duplicate message after escalating | Ending the turn after `pause_ai`/`close` tools is enforced by the core, not the prompt. |
| AI invents facts (hours, policies) | The prompt has no company facts yet — fill `config/prompts/system.md`. |
| `widget.js` is ~8.5 MB | `matrix-js-sdk` bundles its crypto WASM even with E2EE off. Lazy-load later. |

## 13. Troubleshooting

| Problem | Check |
|---|---|
| Backend exits right after start | `docker compose logs backend` — a `CONFIG ERROR` block names the bad `tools.yaml` entry |
| Customer message gets no AI reply | Backend log lines `ai replied` / `ai error` (shows HTTP status of the LLM); `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` in `.env`; hand-off status might not be `ai` |
| "Sorry, something went wrong" in chat | `ai error` log with `status`/`code`; usually LLM auth or model name |
| Agent never gets assigned | Agent must be **Online** in the console (heartbeat); check `agents` table `online`/`last_seen`; check the agent isn't at `max_concurrent` with stale unresolved chats |
| Chat stuck in `waiting` | Fallback timer is `fallback_after_seconds` (300 s default); look for `fallback fired` in logs |
| Email not sent | `email send failed` log shows only an error code; verify `SMTP_*`; Gmail needs an App Password; Mailpit inbox at `:8025` |
| Webhook test fails from Docker | Use `http://host.docker.internal:<port>` for services on your machine; allow Node through the Windows firewall |
| Synapse won't start after config change | `docker compose logs synapse`; re-render with `bash scripts/init.sh` |
| Everything is broken / want a clean slate | `docker compose down -v && rm -rf data && bash scripts/init.sh` (**deletes all data**) |

## 14. Roadmap and out-of-scope (v1)

Not built, but not blocked: end-to-end encryption (flag and crypto-ready SDK init exist; the AI could not read encrypted rooms without extra work), media/attachments (non-text events are ignored), voice/video (LiveKit + MatrixRTC), compliance archiving, multi-instance backend (locks/timers are in-process), production TLS/domain and Azure hardening. See "Production TODO" in the root README.

## 15. Glossary

**Appservice** — trusted backend that can act as a namespace of Matrix users. **Hand-off** — which party (AI, queue, human, external) is currently responsible for a conversation. **Hand-off state** — the `com.supportchat.handoff` room state event. **Notice** — an `m.notice` message used for system text. **Internal notice** — a notice flagged `com.supportchat.internal`, meant for agents only. **Tool** — an action the AI may invoke, defined in `tools.yaml`. **`after`** — what the core does once a tool succeeds (`pause_ai`, `continue_ai`, `close`). **Fallback** — alternative tool offered when no human agent becomes available. **mxid** — a Matrix user ID such as `@agent_alice:chat.local`.
