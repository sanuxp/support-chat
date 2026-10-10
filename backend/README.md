# backend — Node service

The brain of the system: a Matrix **application service**, the **AI agent**, the **tool system**, **hand-off routing**, and the **REST API** used by the widget and agent console. Node 22, TypeScript (strict, ESM), Fastify, `pg`, `openai`, `matrix-bot-sdk`, `nodemailer`, `zod`/`ajv`.

Read [`../docs/DEVELOPER_GUIDE.md`](../docs/DEVELOPER_GUIDE.md) first for the big picture. This file is the module-level map.

## Run, build, test

The backend is meant to run **in Docker** (Synapse delivers room events to `http://backend:9000`).

```bash
docker compose up -d --build backend     # rebuild after any code change
docker compose logs -f backend
cd backend && npm run typecheck          # tsc --noEmit (fast feedback before rebuilding)
```

Scripts: `dev` (tsx watch — only useful if you also expose the appservice port to Synapse), `build` (tsc → `dist/`), `start`, `typecheck`. The Dockerfile is a two-stage build; `src/db/schema.sql` is copied next to the compiled output and `config/` is bind-mounted by compose so config edits don't need a rebuild.

Tests live in [`../scripts`](../scripts/README.md) (they exercise the running stack; there are no unit tests yet).

## Configuration

- Environment: `src/config.ts` reads required env vars and fails fast if one is missing (`MATRIX_SERVER_NAME`, `AS_TOKEN`, `HS_TOKEN`, `DATABASE_URL`, `BACKEND_JWT_SECRET`, `MATRIX_PUBLIC_BASEURL`). The full list is in the root README.
- Behaviour: `config/tools.yaml` and `config/prompts/*.md` (see "Tools" in the guide and the worked example in the root README).

## Module map (`src/`)

| Path | Responsibility |
|---|---|
| `index.ts` | Startup order: DB → load tools (refuse to start if invalid) → watch config (dev) → start AI listener → appservice → REST API → resume waiting chats |
| `config.ts` | Typed env access; `aiUserId`, `adminUserId` |
| **`matrix/`** | Everything that talks to Synapse |
| `matrix/synapse.ts` | The one raw HTTP helper: `synapse(method, path, {token, actAs, body})`. `actAs` adds `?user_id=` to act as an appservice user. Throws `MatrixHttpError(status, errcode)` |
| `matrix/appservice.ts` | `matrix-bot-sdk` `Appservice` (receives events on :9000). Uses a single-namespace registration view (SDK limitation) |
| `matrix/users.ts` | `ensureUser` (register via appservice), `loginAs` (`m.login.application_service`) |
| `matrix/rooms.ts` | Create the conversation room (v11, power levels, custom state), read/write hand-off state, invite/kick, customer ref |
| `matrix/messages.ts` | Send message/notice (with extra content flags), edit (`m.replace`), typing, history (edits applied), transcript |
| `matrix/admin.ts` | `@svc_admin` token cache; `purgeRoom` via Delete Room v2 |
| **`ai/`** | The AI agent |
| `ai/agent.ts` | Listens for customer messages, decides if the AI may reply, builds context, runs the stream + tool loop, per-room serialisation |
| `ai/llm.ts` | OpenAI-compatible streaming client (`LLM_BASE_URL` with or without `/v1`); aggregates streamed tool calls |
| `ai/prompt.ts` | Async prompt assembly: `system.md` placeholders + per-tool snippets |
| `ai/streaming.ts` | `StreamingMessage`: first chunk as a message, then throttled edits |
| **`tools/`** | Pluggable tools |
| `tools/registry.ts` | Load/validate `tools.yaml`, env resolution, handler wiring, `executeTool` (validation → handler → `customer_message` → `after`), reload, dev file watch |
| `tools/types.ts` | `ToolHandler`, `ToolContext`, `ToolResult` — the contract for handlers |
| `tools/template.ts` | `{{field}}` rendering and `${ENV}` resolution |
| `tools/handlers/humanChat.ts` | Queue + assign + fallback timer |
| `tools/handlers/email.ts` | SMTP send via `nodemailer` |
| `tools/handlers/webhook.ts` | Signed HTTP call with timeout |
| `tools/custom/` | Your own handlers (`example.ts` shows the pattern) |
| **`routing/`** | Who handles a conversation |
| `routing/handoff.ts` | `updateHandoff` (the only place status changes: Matrix state + DB), fallback timers |
| `routing/agents.ts` | Agent auth (`whoami`), presence, `pickAgent`, locked assignment (`assignToBestAgent`, `assignToAgent`), `processQueue`, `resolveConversation` |
| `routing/startup.ts` | Re-arm timers and re-check the queue after a restart |
| **`api/`** | REST |
| `api/server.ts` | Fastify app, CORS (incl. DELETE), tolerant JSON parser, route registration |
| `api/customer.ts` | `POST /session`, `DELETE /conversations/:roomId`, backend-token verification, `httpError` helper |
| `api/agent.ts` | presence, conversations, accept, resolve |
| `api/admin.ts` | `reload-config` (constant-time token check) |
| **`db/`** | `db.ts` (pool + `initDb`), `schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS`) |

## Rules to follow when changing code

1. **Never log customer content** — no message bodies, prompts, LLM output, tool arguments, email addresses, or raw error messages that might echo them. Log ids, tool names, timings, counts, error classes. `scripts/smoke-test.ts` step 11 enforces this.
2. **Async only.** Use `fs/promises` and non-blocking APIs; run independent awaits with `Promise.all`.
3. **Change hand-off status only via `updateHandoff`**, and assign agents only via the locked functions in `routing/agents.ts`.
4. **Tools return, not throw.** Handlers return `{ ok, llmResult }` with a safe message. The core applies `customer_message` and `after`.
5. **Validate at the edges:** tool arguments are validated with the tool's JSON Schema before the handler runs; visitor ids must be UUIDs; room ownership is checked in Postgres before delete.
6. New env vars: add to `config.ts` (or read at use), `.env.example` (dummy value), and the root README table.

## Adding a custom tool in 3 steps

1. `src/tools/custom/mytool.ts`:
   ```ts
   import type { ToolHandler } from "../types.js";
   const handler: ToolHandler = {
     async execute(args, ctx) {
       ctx.log.info("mytool called");               // never log args
       return { ok: true, llmResult: { answer: 42 } };
     },
   };
   export default handler;
   ```
2. `config/tools.yaml`: add `handler: custom`, `module: mytool`, a `description`, JSON-Schema `parameters`, and `after`.
3. Rebuild/restart the backend (custom modules are cached by Node), then reload config if you only changed yaml/prompts.

## Known limitations

Single-instance only (assignment lock and fallback timers are in memory); no unit tests (coverage is the end-to-end suites); `external_jwt` customer mode and the `ENABLE_E2EE` branch are implemented but untested; `resolved` exists in `HandoffStatus` but isn't currently used.
