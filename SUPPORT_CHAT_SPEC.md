# Support Chat v1 — Build Spec for Claude Code

## 0. Goal

Build a self-hosted, embeddable support chat where a **customer** chats with an **AI agent**, and the AI can **escalate to a human agent** who joins the same conversation from a separate Agent UI.

Built on **Matrix** (Synapse homeserver). v1 is **text only, no end-to-end encryption**, but the code must be structured so E2EE and voice/video can be added later without a rewrite.

The developer will run and test everything locally. Produce working code, configs, scripts and a README.

---

## 1. Ground rules for Claude Code

1. **Nothing exists locally yet.** Create the project folder and clone reference repos first (Section 2).
2. Cloned repos in `./vendor/` are **reference only** (read source, docs, examples to confirm current APIs). Do **not** modify them. Real dependencies come from npm / Docker images.
3. Library APIs change. Before using an API from memory, **check it against the cloned source or docs** (especially `matrix-js-sdk`, `matrix-bot-sdk`, Synapse config options and admin API).
4. Use **TypeScript** for all Node and frontend code.
5. All secrets go in `.env` (with a committed `.env.example`). Never hardcode secrets.
6. If something in this spec is impossible or clearly wrong with current library versions, stop and explain the problem plus your proposed alternative before proceeding.
7. Work in the milestone order in Section 9. After each milestone, make sure it runs before moving on.

---

## 2. Repos to clone (reference)

```bash
mkdir -p support-chat/vendor && cd support-chat/vendor
git clone --depth 1 https://github.com/element-hq/synapse.git
git clone --depth 1 https://github.com/matrix-org/matrix-js-sdk.git
git clone --depth 1 https://github.com/turt2live/matrix-bot-sdk.git
```

What each is for:

| Repo | Use |
|---|---|
| `element-hq/synapse` | Config reference (`docs/usage/configuration/config_documentation.md`), appservice docs, admin API docs (`docs/admin_api/`). Run Synapse via Docker image, not from source. |
| `matrix-org/matrix-js-sdk` | Client SDK for the customer widget and Agent UI. |
| `turt2live/matrix-bot-sdk` | Application Service + bot framework for the backend / AI agent. |

Future (do **not** clone or use in v1): `livekit/livekit`, `livekit/agents` for voice/video via MatrixRTC.

---

## 3. Architecture

```
┌──────────────┐      ┌──────────────┐
│ Customer     │      │ Agent UI     │
│ Widget       │      │ (React)      │
│ (React,      │      │ matrix-js-sdk│
│ embeddable)  │      └──────┬───────┘
│ matrix-js-sdk│             │ Matrix C-S API + Backend REST
└──────┬───────┘             │
       │ Matrix C-S API      │
       │ + Backend REST      │
┌──────▼─────────────────────▼───────┐
│ Reverse proxy (Caddy)              │
└──────┬─────────────────────┬───────┘
       │                     │
┌──────▼───────┐   ┌─────────▼──────────┐      ┌──────────────────┐
│ Synapse      │◄──┤ Backend            ├─────►│ Azure OpenAI     │
│ + Postgres   │──►│ (Node, Appservice, │      │ (chat completions│
│ federation   │   │  AI bot, routing,  │      │  deployment)     │
│ OFF          │   │  REST API)         │      └──────────────────┘
└──────────────┘   └────────────────────┘
```

- **Synapse**: homeserver, federation disabled, public registration disabled.
- **Backend** (single Node service) runs:
  - Matrix **Application Service** owning the namespaces `@customer_.*`, `@ai_agent`, `@svc_admin`.
  - **AI agent** logic (`@ai_agent` user).
  - **Routing / escalation** service.
  - **REST API** for the widget and Agent UI.
- **Widget**: embeddable customer chat (built as a single JS bundle + a demo host page).
- **Agent UI**: web app for human agents.

---

## 4. Project layout

```
support-chat/
├── vendor/                     # cloned reference repos (gitignored)
├── docker-compose.yml
├── .env.example
├── README.md
├── synapse/
│   ├── homeserver.yaml.template
│   ├── appservice-registration.yaml.template
│   └── log.config
├── caddy/
│   └── Caddyfile
├── scripts/
│   ├── init.sh                 # generate secrets, render templates, first-run setup
│   ├── create-agent.ts         # create a human agent account
│   └── smoke-test.ts           # end-to-end test (Section 10)
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── config/                 # USER-EDITABLE, no code changes needed
│   │   ├── tools.yaml          # tool + escalation definitions (Section 7.3)
│   │   └── prompts/
│   │       ├── system.md       # main AI system prompt
│   │       └── *.md            # per-tool prompt snippets / email templates
│   └── src/
│       ├── index.ts
│       ├── config.ts
│       ├── matrix/
│       │   ├── appservice.ts   # matrix-bot-sdk Appservice setup
│       │   ├── rooms.ts        # create conversation room, power levels, state
│       │   └── users.ts        # ensure customer users, issue tokens
│       ├── ai/
│       │   ├── agent.ts        # handles customer messages, calls LLM, replies
│       │   ├── llm.ts          # Azure OpenAI client wrapper
│       │   ├── prompt.ts       # loads config/prompts, builds final system prompt
│       │   └── streaming.ts    # throttled message edits
│       ├── tools/
│       │   ├── registry.ts     # loads tools.yaml, validates, exposes to LLM
│       │   ├── types.ts        # ToolHandler interface
│       │   ├── handlers/
│       │   │   ├── humanChat.ts  # in-chat human escalation
│       │   │   ├── email.ts      # escalate via email
│       │   │   └── webhook.ts    # call any HTTP endpoint
│       │   └── custom/         # user's own TS handlers, auto-loaded
│       │       └── example.ts
│       ├── routing/
│       │   ├── handoff.ts      # handoff state changes (single place)
│       │   └── agents.ts       # agent presence/availability + assignment
│       ├── api/
│       │   ├── server.ts       # Fastify
│       │   ├── customer.ts
│       │   └── agent.ts
│       └── db/
│           ├── schema.sql
│           └── db.ts
├── widget/
│   ├── package.json
│   ├── vite.config.ts          # library build → widget.js
│   ├── index.html              # demo host page embedding the widget
│   └── src/
│       ├── embed.ts            # window.SupportChat.init({...})
│       ├── ChatWidget.tsx
│       └── matrixClient.ts
└── agent-ui/
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── App.tsx
        ├── Login.tsx
        ├── Queue.tsx
        ├── ConversationView.tsx
        └── matrixClient.ts
```

---

## 5. Infrastructure

### 5.1 docker-compose services

- `postgres` (Postgres 16). **Synapse requires C collation**:
  `POSTGRES_INITDB_ARGS=--encoding=UTF-8 --lc-collate=C --lc-ctype=C`
  Two databases: `synapse` and `support_backend`.
- `synapse` (`matrixdotorg/synapse` image, pin a specific recent version tag).
- `backend` (built from `backend/Dockerfile`).
- `caddy` (reverse proxy, serves widget + agent-ui static builds, proxies `/_matrix` to Synapse and `/api` to backend).
- `mailpit` (local fake SMTP server + web inbox, for testing email escalation).

Widget and Agent UI must also run with `vite dev` for local development.

### 5.2 Synapse config (key settings)

Render `homeserver.yaml` from template in `scripts/init.sh`. Required settings:

```yaml
server_name: "${MATRIX_SERVER_NAME}"
public_baseurl: "${MATRIX_PUBLIC_BASEURL}"

database:
  name: psycopg2
  args: { user: ..., password: ..., database: synapse, host: postgres }

enable_registration: false
federation_domain_whitelist: []          # federation off
url_preview_enabled: false
encryption_enabled_by_default_for_room_type: "off"   # v1: no E2EE

push:
  include_content: false

app_service_config_files:
  - /data/appservice-registration.yaml

retention:
  enabled: true                           # policy values configurable later
```

Verify each option name against `vendor/synapse/docs/usage/configuration/config_documentation.md`.

### 5.3 Appservice registration

```yaml
id: support-backend
url: "http://backend:9000"
as_token: "${AS_TOKEN}"
hs_token: "${HS_TOKEN}"
sender_localpart: ai_agent
rate_limited: false
namespaces:
  users:
    - { exclusive: true, regex: "@customer_.*:${MATRIX_SERVER_NAME}" }
    - { exclusive: true, regex: "@svc_admin:${MATRIX_SERVER_NAME}" }
  aliases: []
  rooms: []
```

Human agents (`@agent_*`) are **normal password accounts**, not appservice users, because they log in themselves.

### 5.4 Environment variables (`.env.example`)

```
MATRIX_SERVER_NAME=chat.local
MATRIX_PUBLIC_BASEURL=http://localhost:8008
AS_TOKEN=
HS_TOKEN=
SYNAPSE_REGISTRATION_SHARED_SECRET=
POSTGRES_PASSWORD=
BACKEND_PORT=3000
APPSERVICE_PORT=9000
BACKEND_JWT_SECRET=              # signs customer session tokens for backend REST
CUSTOMER_AUTH_MODE=anonymous     # anonymous | external_jwt
EXTERNAL_JWT_PUBLIC_KEY=         # only if external_jwt
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_DEPLOYMENT=
AZURE_OPENAI_API_VERSION=
AI_HISTORY_MESSAGES=30
AI_STREAM_EDIT_INTERVAL_MS=1000
ENABLE_E2EE=false                # hook for later, must stay false in v1
TOOLS_CONFIG_PATH=./config/tools.yaml
PROMPTS_DIR=./config/prompts
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=support@chat.local
WEBHOOK_SIGNING_SECRET=          # HMAC secret for outgoing webhook calls
```

`scripts/init.sh` must generate random values for tokens/secrets if empty.

---

## 6. Data model

### 6.1 Matrix room per conversation

- Created by `@ai_agent` with `preset: private_chat`, **no** `m.room.encryption` state (unless `ENABLE_E2EE=true`, which is not used in v1 but the branch must exist).
- `history_visibility: shared` (so an agent who joins later can read earlier messages).
- Members: customer, `@ai_agent`; later the assigned human agent.
- Power levels: `@ai_agent` = 100, `@svc_admin` = 100, customer = 0, agents = 0 (agents change state via backend API, not directly).

Custom state event, type `com.supportchat.handoff`, state_key `""`:

```json
{
  "status": "ai",            // ai | waiting | assigned | escalated_external | resolved | closed
  "agent_id": null,          // @agent_x:server when assigned
  "channel": null,           // which tool escalated, e.g. "escalate_to_human_chat", "escalate_via_email"
  "reason": null,            // why AI escalated
  "summary": null,           // AI-written summary for the agent
  "updated_at": 0
}
```

Custom state event `com.supportchat.conversation`: `{ "customer_ref": "<external or anonymous id>", "created_at": 0 }`.

### 6.2 Backend Postgres (`support_backend`)

```sql
customers(id uuid pk, external_ref text unique, matrix_user_id text unique, created_at timestamptz)
conversations(id uuid pk, customer_id uuid fk, room_id text unique, status text, assigned_agent text null,
              created_at timestamptz, updated_at timestamptz, deleted_at timestamptz null)
agents(matrix_user_id text pk, display_name text, max_concurrent int default 3,
       online boolean default false, last_seen timestamptz)
```

Matrix room state is the source of truth for conversation status; the `conversations` table is an index for fast queries and routing. Keep them in sync in one place (`routing/escalation.ts`).

---

## 7. Backend behaviour

### 7.1 Customer session — `POST /api/customer/session`

- `CUSTOMER_AUTH_MODE=anonymous`: request body `{ visitorId? }`. If missing, generate one. Return it so the widget stores it in `localStorage`.
- `CUSTOMER_AUTH_MODE=external_jwt`: request carries a JWT from the host app; verify with `EXTERNAL_JWT_PUBLIC_KEY`; `sub` = `external_ref`.
- Ensure Matrix user `@customer_<uuid>` exists (register via appservice).
- Obtain a Matrix access token for that user via appservice login (`m.login.application_service`). Verify the login type against Synapse docs.
- Find the customer's open conversation or create one (Section 6.1); join the customer to the room via appservice.
- Response:

```json
{ "visitorId": "...", "homeserverUrl": "...", "userId": "...", "accessToken": "...",
  "deviceId": "...", "roomId": "...", "backendToken": "<JWT for backend REST>" }
```

### 7.2 AI agent

Trigger: `m.room.message` in a conversation room, sender is the customer, and handoff `status` is one where the AI is allowed to talk (`ai`, plus `escalated_external` if that tool's `after` = `continue_ai`, see 7.3).

Steps:
1. Send typing indicator as `@ai_agent`.
2. Load last `AI_HISTORY_MESSAGES` messages from the room (`/messages`), map to chat roles (customer → `user`, `@ai_agent` → `assistant`, human agent messages → `user` with a name prefix, `m.notice` from system → skip).
3. Build system prompt (7.3.4) and tool list from the tool registry (7.3).
4. Call Azure OpenAI **chat completions** (stateless; do not use Assistants/threads) using the `openai` npm package's `AzureOpenAI` client, with streaming.
5. **Tool-call loop**: if the model calls a tool, run its handler, append the tool result as a `tool` message, call the model again. Max `max_tool_rounds` (default 3) per customer message. Text produced by the model is streamed to the room as below.
6. Streaming to Matrix: send first chunk as a new message, then edit it with `m.replace` at most once per `AI_STREAM_EDIT_INTERVAL_MS`, and a final edit when done.
7. Stop typing indicator.
8. Errors: post a polite `m.notice` ("Sorry, something went wrong, please try again") and log the error **without message content**.

**Logging rule:** never log message bodies, LLM prompts/responses or tool arguments containing customer data. Log only ids, tool names, timings, token counts, errors.

### 7.3 Tools & escalation (pluggable, config-driven)

Escalation is **not hardcoded**. Every action the AI can take (escalate to human in chat, escalate via email, call an internal system, anything else) is a **tool** defined in `config/tools.yaml`, with its own description and prompt text. The developer adds, removes or changes tools and prompts by editing config (and, for custom logic, dropping a TS file in `tools/custom/`). No core code changes.

#### 7.3.1 `config/tools.yaml` format

```yaml
max_tool_rounds: 3

tools:
  - name: escalate_to_human_chat
    enabled: true
    handler: human_chat                 # built-in handler
    description: >
      Hand the conversation to a live human support agent in this same chat.
    prompt_file: prompts/escalate_human_chat.md   # extra instructions appended to system prompt
    parameters:                         # JSON Schema given to the LLM
      type: object
      properties:
        reason:  { type: string }
        summary: { type: string, description: Short summary for the human agent. }
      required: [reason, summary]
    after: pause_ai                     # pause_ai | continue_ai | close
    customer_message: "I'm connecting you with a member of our team. They'll join this chat shortly."
    options:
      fallback_tool: escalate_via_email # used if no agent is available within timeout
      fallback_after_seconds: 300

  - name: escalate_via_email
    enabled: true
    handler: email
    description: >
      Escalate the issue to the support team by email when live chat is not suitable
      or no agent is available. Ask the customer for their email address first.
    prompt_file: prompts/escalate_email.md
    parameters:
      type: object
      properties:
        customer_email: { type: string, format: email }
        reason:  { type: string }
        summary: { type: string }
      required: [customer_email, reason, summary]
    after: continue_ai
    customer_message: "Thanks, I've passed this to our support team. They'll reply to {{customer_email}}."
    options:
      to: ["support@example.com"]
      subject_template: "[Chat escalation] {{reason}}"
      body_template_file: prompts/email_body.md   # placeholders: {{summary}}, {{reason}}, {{customer_email}}, {{room_id}}, {{transcript}}
      include_transcript: true

  - name: create_ticket
    enabled: false
    handler: webhook
    description: Create a support ticket in the ticketing system.
    parameters:
      type: object
      properties:
        title:    { type: string }
        priority: { type: string, enum: [low, normal, high] }
        summary:  { type: string }
      required: [title, summary]
    after: continue_ai
    options:
      url: "https://tickets.internal/api/tickets"
      method: POST
      headers: { Authorization: "Bearer ${TICKETS_API_TOKEN}" }   # ${VAR} resolved from env
      timeout_ms: 10000
      include_transcript: false
      return_response_to_llm: true      # LLM sees the webhook response (e.g. ticket id)

  - name: lookup_order
    enabled: false
    handler: custom
    module: example                     # loads backend/src/tools/custom/example.ts
    description: Look up an order's status by order number.
    parameters:
      type: object
      properties:
        order_number: { type: string }
      required: [order_number]
    after: continue_ai
```

Rules:
- `name` must be unique and match `^[a-zA-Z0-9_-]{1,64}$`.
- Validate the whole file at startup (zod or ajv). On error, refuse to start and print a clear message pointing to the bad entry.
- `${VAR}` in `options` is replaced from environment variables. `{{field}}` in templates is replaced from tool arguments + context (`room_id`, `customer_ref`, `transcript`, `reason`, `summary`, ...).
- Only `enabled: true` tools are sent to the LLM.
- Provide `POST /api/admin/reload-config` (protected by an admin token env var) to reload tools and prompts without restart. Also reload on file change in dev mode.

#### 7.3.2 Handler interface (`tools/types.ts`)

```ts
export interface ToolContext {
  roomId: string;
  customerRef: string;
  matrix: { sendNotice(text: string): Promise<void>; getTranscript(limit?: number): Promise<string>; };
  handoff: { set(update: Partial<HandoffState>): Promise<void>; get(): Promise<HandoffState>; };
  options: Record<string, unknown>;   // tool's options from yaml, env-resolved
  log: Logger;                        // must not log customer content
}

export interface ToolResult {
  ok: boolean;
  llmResult: unknown;                 // returned to the LLM as the tool message content
  customerMessage?: string;           // overrides yaml customer_message if set
}

export interface ToolHandler {
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
```

Custom handlers in `tools/custom/<module>.ts` default-export a `ToolHandler`. Ship `example.ts` returning fake data so the pattern is clear.

#### 7.3.3 Built-in handlers

**`human_chat`**
1. Set handoff → `waiting`, `channel`, `reason`, `summary`.
2. Routing picks an agent: online, below `max_concurrent`, fewest active conversations. If none, stay `waiting` (queue).
3. Invite agent, set handoff → `assigned` with `agent_id`, post summary as `m.notice`.
4. If still `waiting` after `fallback_after_seconds` and `fallback_tool` set: tell the customer no agent is free, set handoff back to `ai`, and instruct the AI (via an injected system note on its next turn) to offer the fallback tool. Do not call the fallback tool automatically without needed args (e.g. email).
5. Re-check the waiting queue whenever an agent comes online or resolves a conversation.

**`email`**
- Send with `nodemailer` via SMTP env settings. Render subject/body templates. Attach transcript as plain text in the body if `include_transcript`.
- Set handoff → `escalated_external`, `channel`.
- `llmResult`: `{ sent: true }` or `{ sent: false, error: "<safe message>" }`.

**`webhook`**
- Send JSON `{ tool, args, room_id, customer_ref, transcript? }` with header `X-SupportChat-Signature: sha256=<HMAC of body with WEBHOOK_SIGNING_SECRET>`.
- Respect `timeout_ms`; on failure return `ok: false` with a safe error to the LLM.
- If `return_response_to_llm`, pass parsed JSON response (truncate to 4 KB) as `llmResult`.

#### 7.3.4 `after` behaviour (applied by the core, not the handler)

| `after` | Effect |
|---|---|
| `pause_ai` | AI stops replying in this room until status returns to `ai`. |
| `continue_ai` | AI keeps chatting (e.g. after email sent, or after a lookup). |
| `close` | Post `customer_message`, set status `closed`; widget shows "conversation ended, start new". |

Post `customer_message` (if any) as `@ai_agent` after a successful tool run. If the tool fails, do not post it; let the LLM explain to the customer.

#### 7.3.5 Prompts

- `config/prompts/system.md` = main system prompt, fully user-editable. Supports placeholders `{{company_name}}`, `{{now}}`, `{{available_tools}}` (auto list of enabled tool names + descriptions).
- For each enabled tool with `prompt_file`, append its content under a heading `## Tool: <name>`.
- Ship sensible defaults: `system.md`, `escalate_human_chat.md` (when to escalate live: customer asks for a human, is frustrated, needs account actions), `escalate_email.md` (use when outside hours / no agent / customer prefers email; always ask for and confirm email first), `email_body.md`.

### 7.4 Agent REST API (auth: agent's Matrix access token, verified via `/account/whoami`)

- `POST /api/agent/presence` `{ online: boolean }`
- `GET  /api/agent/conversations` → assigned + waiting list
- `POST /api/agent/conversations/:roomId/accept` → only if assigned to this agent (or picking from queue)
- `POST /api/agent/conversations/:roomId/resolve` `{ returnToAi: boolean }` → status `ai` (agent is kicked/leaves) or `closed`

### 7.5 Customer delete — `DELETE /api/customer/conversations/:roomId`

- Auth via `backendToken`, must own the room.
- Call Synapse Admin **Delete Room** API (v2) with `purge: true` using `@svc_admin`'s token. (Make `@svc_admin` a server admin during `init.sh` — verify the correct way in Synapse admin docs.)
- Mark `deleted_at` in `conversations`.
- Widget then starts a fresh conversation on next message.

---

## 8. Frontends

### 8.1 Customer widget

- Build as a library bundle `widget.js`. Host page usage:

```html
<script src="https://<host>/widget.js"></script>
<script>
  SupportChat.init({ backendUrl: "https://<host>", authToken: null /* JWT if external_jwt */ });
</script>
```

- Floating button → chat panel. Render inside a **Shadow DOM** so host page CSS does not leak in.
- Uses `matrix-js-sdk` with the token from `/api/customer/session`. Single room only.
- Features: message list, send, typing indicator for AI/agent, handle `m.replace` edits (streamed AI replies), show "Agent <name> joined", "Delete conversation" button with confirm.
- Persist `visitorId` in `localStorage` so refresh keeps history.
- Initialize the SDK in a way that allows enabling crypto later (keep crypto init behind `ENABLE_E2EE` flag; off in v1).

### 8.2 Agent UI

- Login with Matrix username/password (standard `m.login.password`).
- Online/offline toggle → `/api/agent/presence`.
- Queue view: waiting + my assigned conversations (from backend API, live-updated via Matrix sync of `com.supportchat.handoff` state).
- Conversation view: full history (visible because `history_visibility: shared`), AI summary notice highlighted, send messages, Resolve button (return to AI / close).
- Clean, simple layout; desktop-first.

---

## 9. Milestones (do in order, verify each)

1. **Scaffold**: clone vendor repos, create layout, `.env.example`, `init.sh`, docker-compose with Postgres + Synapse. Verify `curl $MATRIX_PUBLIC_BASEURL/_matrix/client/versions` works.
2. **Appservice**: backend boots, registers with Synapse, `@ai_agent` exists, can create a room.
3. **Customer session**: `/api/customer/session` returns working token + room; a test script can send a message as the customer.
4. **AI replies**: Azure OpenAI wired up, streaming via edits, typing indicators.
5. **Widget**: embeddable widget on demo page, full customer ↔ AI chat.
6. **Agents**: `create-agent.ts`, Agent UI login, presence, queue.
7. **Tool system**: `tools.yaml` loading + validation, prompt assembly, tool-call loop, `after` behaviour, reload endpoint, `custom/example.ts`.
8. **Human chat escalation**: tool call → routing → invite → summary → human chat → resolve, plus fallback timeout.
9. **Email + webhook handlers**: verify email lands in Mailpit; webhook tested against a tiny local echo server in `scripts/`.
10. **Delete conversation**.
11. **Smoke test + README**.

---

## 10. Acceptance / smoke test (`scripts/smoke-test.ts`)

Automate as much as possible:

1. Create customer session (anonymous).
2. Send "Hello" → receive an AI reply within 30 s.
3. Send "I want to talk to a human" → handoff state becomes `waiting`, then `assigned` (with a test agent set online).
4. Test agent sends a message → customer receives it.
5. AI does not reply while assigned.
6. Agent resolves with `returnToAi: true` → next customer message gets an AI reply.
7. With no agent online, ask for email escalation and give an email → email appears in Mailpit with summary + transcript, handoff status `escalated_external`, AI keeps replying.
8. Enable `create_ticket` pointed at the local echo server → AI calls it, signature header is valid, response reaches the LLM.
9. Break `tools.yaml` on purpose → backend refuses to start with a clear error.
10. Customer deletes conversation → room purged (admin API confirms), new session creates new room.
11. Confirm backend logs contain no message bodies or tool arguments (grep test strings in log output).

README must include: how to add/edit a tool and its prompt (with one full example), prerequisites, `init.sh`, `docker compose up`, creating an agent, running widget and agent-ui in dev, running the smoke test, and env var reference.

---

## 11. Out of scope for v1 (but don't block)

- **E2EE**: keep `ENABLE_E2EE` flag and crypto-ready SDK init. Do not implement key backup.
- **Media/attachments**: text only. Ignore non-text events gracefully.
- **Voice/video**: future LiveKit + MatrixRTC. No code now.
- **Compliance/archiving**: not now.
- **Azure hardening** (private endpoint, VNet, abuse-monitoring opt-out): infra task later, note it in README "Production TODO".
- **Production deploy / TLS certificates**: local dev only; Caddy config should be easy to switch to a real domain.