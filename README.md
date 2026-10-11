# Support Chat v1

Self-hosted, embeddable support chat. A **customer** talks to an **AI agent**; the AI can **escalate to a human agent** who joins the *same* conversation from a separate Agent console. Built on Matrix (Synapse). v1 is text only, no end-to-end encryption, federation off.

```
Customer widget ─┐                       ┌─ Azure/any OpenAI-compatible LLM (LiteLLM)
 (Shadow DOM)    ├─ Caddy :8008 ─ Synapse + Postgres
Agent console ───┘        └──── Backend (appservice, AI, routing, REST) ─┬─ SMTP (Mailpit / Gmail / …)
                                                                        └─ your webhooks
```

| Folder | What |
|---|---|
| `synapse/`, `caddy/`, `postgres/`, `docker-compose.yml` | Infrastructure |
| `backend/` | Node 22 service: Matrix appservice, AI agent, tools, routing, REST API |
| `backend/config/` | **Edit these, no code changes:** `tools.yaml`, `prompts/*.md` |
| `widget/` | Embeddable customer widget → `widget.js` |
| `agent-ui/` | React console for human agents (served at `/agent/`) |
| `scripts/` | `init.sh`, `create-agent.ts`, `smoke-test.ts`, echo server, e2e tests |
| `vendor/` | Cloned reference repos (read-only, gitignored) |
| `SDLC.md` | Living design/decision/test log |
| `docs/DEVELOPER_GUIDE.md` | **New to the project? Start here** — architecture, flows, conventions, gotchas |
| `*/README.md` | Per-folder guides: `backend`, `widget`, `agent-ui`, `scripts`, `synapse` (infrastructure) |

## Prerequisites

- Docker Desktop (Compose v2)
- Node 20+ on the host (for the widget, console and scripts; the backend itself runs in a Node 22 container)
- Bash (Git Bash on Windows) and `openssl`, `curl`
- An OpenAI-compatible LLM endpoint (a LiteLLM proxy, OpenAI, or Azure via LiteLLM)

## Quick start

```bash
# 1. Create .env, generate secrets, render Synapse config, start Postgres + Synapse,
#    create the @svc_admin appservice user and promote it to server admin
bash scripts/init.sh

# 2. Fill in your LLM settings in .env
#      LLM_BASE_URL=https://your-litellm-host     (with or without /v1)
#      LLM_API_KEY=...
#      LLM_MODEL=gpt-4.1-mini

# 3. Install and build the frontends (Caddy serves the built output)
(cd widget   && npm install && npm run build)
(cd agent-ui && npm install && npm run build)

# 4. Start everything
docker compose up -d --build

# 5. Create a human agent (becomes @agent_alice:chat.local)
npm install
npm run create-agent -- alice 'a-strong-password' 'Alice'
```

Then open:

- **Demo site with the widget:** http://localhost:8008/
- **Agent console:** http://localhost:8008/agent/ (log in as `agent_alice`, click *Offline* → *Online*)
- **Mailpit inbox (test emails):** http://localhost:8025

### Development mode

```bash
cd widget   && npm run dev     # http://localhost:5173  (talks to Caddy on :8008)
cd agent-ui && npm run dev     # http://localhost:5174/agent/
```

Backend/Synapse stay in Docker. After changing backend code: `docker compose up -d --build backend`.

## Passing user details from your web page

The host page can tell the chat who the visitor is, so the AI can greet them by name, human agents see their contact details, and escalation emails/webhooks carry them. Everything is **optional**.

```html
<script src="https://your-host/widget.js"></script>
<script>
  SupportChat.init({
    backendUrl: "https://your-host",
    user: {                                  // all three optional
      name:  "Priya Nair",
      email: "priya@example.com",
      phone: "+91 98123 45678"
    },
    metadata: { plan: "pro", orders: 3 },    // optional free-form facts (see limits below)
    customHeaders: { "X-Tenant-Id": "acme" } // optional extra headers sent with the session request
  });
</script>
```

Try it on the demo page: `http://localhost:8008/?name=Priya%20Nair&email=priya%40example.com&phone=%2B919812345678`.

### What is sent

When the widget starts a session it calls `POST /api/customer/session` with these HTTP headers (values are URI-encoded so non-ASCII names work; the backend decodes them):

| Header | Meaning | Accepted if |
|---|---|---|
| `X-Customer-Name` | Display name | 1–100 characters |
| `X-Customer-Email` | Email address | looks like `a@b.c`, ≤ 254 characters |
| `X-Customer-Phone` | Mobile number | optional `+`, then 6–20 digits/spaces/`()-` |
| `X-Customer-Meta` | JSON object of extra facts | ≤ 20 keys; key `[A-Za-z0-9_]{1,40}`; value string (≤ 200 chars), number or boolean — anything else is dropped |
| any header from `customHeaders` | Sent as-is (the backend ignores unknown ones; useful for a gateway/proxy in front of it) | — |

You can also call the endpoint yourself (e.g. from a server or a test):

```bash
curl -X POST http://localhost:8008/api/customer/session \
  -H "Content-Type: application/json" \
  -H "X-Customer-Name: Priya%20Nair" \
  -H "X-Customer-Email: priya%40example.com" \
  -H "X-Customer-Phone: %2B919812345678" \
  -d '{}'
```

The response includes the resolved `profile: { name, email, phone }`.

### Defaults and update rules

- **Nothing sent, nothing stored yet →** defaults: `Test User`, `testuser@test.com`, `+9876543210`. Override them with `DEFAULT_CUSTOMER_NAME` / `DEFAULT_CUSTOMER_EMAIL` / `DEFAULT_CUSTOMER_PHONE` in `.env`.
- **A field is sent and valid →** it is stored and replaces the old value.
- **A field is missing or invalid →** the stored value is kept; if there is none, the default applies. (An invalid email never causes an error; it is just ignored.)
- **Metadata** replaces the stored metadata whenever a valid `X-Customer-Meta` is sent; otherwise the stored metadata stays.
- The customer's Matrix display name is set to their name, so agents see "Priya Nair" instead of an id.

### Logged-in users (`CUSTOMER_AUTH_MODE=external_jwt`)

Anyone can set headers from a browser, so in `anonymous` mode these details are **unverified** — fine for greetings and context, wrong for deciding what someone is allowed to see or do. If your site has real logins, use `external_jwt`: pass the JWT as `authToken` and put the details in its signed claims — `name`, `email`, `phone` (or `phone_number`) and `metadata`. Verified claims **override** the headers.

### Where the details show up

| Place | How |
|---|---|
| **AI** | `backend/config/prompts/system.md` has a "About the customer" block using `{{customer_name}}`, `{{customer_email}}`, `{{customer_phone}}`, `{{customer_meta}}` (one `key: value` per line). Edit or remove it freely |
| **Tool messages and templates** (`customer_message`, email subject/body) | `{{customer_name}}`, `{{customer_email}}`, `{{customer_phone}}`, `{{customer_meta}}`, and `{{meta_<key>}}` per metadata key. If a tool has an argument with the same name (e.g. the email the customer confirmed as `customer_email`), the argument wins |
| **Webhook tools** | The signed payload has `customer: { name, email, phone, metadata }` |
| **Agent console** | Queue rows show the name; the conversation header shows name, email (mailto), phone (tel) and metadata chips |
| **`GET /api/agent/conversations`, `POST .../accept`** | Include a `customer` object |

### Privacy notes

- The details are stored in Postgres (`customers.name/email/phone/metadata`), **sent to your LLM provider** as part of the system prompt (remove the "About the customer" block from `system.md` if you don't want that), and may be emailed to your support inbox.
- They are **never written to the backend logs** (checked by `npm run e2e:profile`). The Matrix display name is visible to anyone in the room and to Synapse admins.
- Don't put secrets or sensitive data (passwords, card numbers, health data) in `metadata`.
- To change details after the widget has started, call `SupportChat.destroy()` and `SupportChat.init(...)` again with the new values.

## Running the tests

```bash
npm install
npm run smoke-test        # full acceptance test, spec section 10 (about 3 minutes, uses the real LLM)
npm run e2e:escalation    # human hand-off flow only
npm run e2e:tools         # tool config, reload endpoint, fallback timeout, queue
npm run e2e:ui            # browser test (needs Microsoft Edge); customer widget + agent console
npm run e2e:profile       # user details from the host page: headers, defaults, validation, AI, agent API, logs
```

The smoke test temporarily edits `backend/config/tools.yaml` (and restores it), creates the `agent_alice` test account, starts a local webhook echo server on port 4010, and closes leftover waiting/assigned conversations first. If `SMTP_HOST=mailpit` it also verifies the email in the Mailpit inbox; with another SMTP server that one check is skipped.

## Adding or editing a tool (and its prompt)

Every action the AI can take is a tool in `backend/config/tools.yaml`. Built-in handlers: `human_chat`, `email`, `webhook`, plus `custom` (your own TypeScript in `backend/src/tools/custom/`).

**Full example: let the AI look up order status with an internal HTTP API.**

1. Add the tool to `backend/config/tools.yaml`:

   ```yaml
   - name: check_order_status
     enabled: true
     handler: webhook
     description: >
       Look up the status of a customer's order. Use it when the customer gives an order number.
     prompt_file: prompts/check_order_status.md      # optional extra instructions for the AI
     parameters:                                      # JSON Schema the LLM must follow
       type: object
       properties:
         order_number: { type: string, description: The order number the customer gave. }
       required: [order_number]
     after: continue_ai                               # pause_ai | continue_ai | close
     options:
       url: "https://orders.internal.example.com/api/status"
       method: POST
       headers: { Authorization: "Bearer ${ORDERS_API_TOKEN}" }   # ${VAR} is read from .env
       timeout_ms: 8000
       return_response_to_llm: true                   # the AI sees the JSON the API returns
   ```

2. Add the secret to `.env` (and `.env.example` with a dummy value): `ORDERS_API_TOKEN=...`
3. Create `backend/config/prompts/check_order_status.md`:

   ```md
   Use `check_order_status` as soon as the customer gives an order number.
   Never guess an order number. If the tool fails, say you can't check right now and offer to escalate.
   ```

4. Reload without restarting: 

   ```bash
   curl -X POST http://localhost:8008/api/admin/reload-config -H "Authorization: Bearer $ADMIN_API_TOKEN"
   ```

   An invalid file is rejected (HTTP 400, with the exact entry and field) and the previous config stays active. At startup an invalid file stops the backend with the same message.

How the pieces fit:

- `{{company_name}}`, `{{now}}`, `{{available_tools}}` work in `prompts/system.md`. Each enabled tool's `prompt_file` is appended under `## Tool: <name>`.
- Webhook calls send `{ tool, args, room_id, customer_ref, transcript? }` with header `X-SupportChat-Signature: sha256=<HMAC-SHA256 of the raw body with WEBHOOK_SIGNING_SECRET>`.
- `after: pause_ai` / `close` end the AI's turn (the system posts `customer_message` instead). `continue_ai` lets the AI keep talking.
- **Custom TypeScript tool:** put `backend/src/tools/custom/mytool.ts` that default-exports a `ToolHandler` (see `example.ts`) and reference it with `handler: custom` + `module: mytool`. Don't log tool arguments (they contain customer data). Custom modules need a backend restart after edits.
- `escalate_to_human_chat` has `fallback_tool` / `fallback_after_seconds`: if no agent takes the chat in time, the customer is told and the AI is told to offer the fallback (it won't call a tool that needs details like an email address until it has them).

## Email (SMTP)

Email settings are plain env values, so switching servers is a `.env` change plus `docker compose up -d backend`.

| Server | Settings |
|---|---|
| Mailpit (default, local) | `SMTP_HOST=mailpit` `SMTP_PORT=1025` (no user/password) |
| Gmail | `SMTP_HOST=smtp.gmail.com` `SMTP_PORT=587` `SMTP_USER=you@gmail.com` `SMTP_PASSWORD=<App Password>` `SMTP_FROM=you@gmail.com` |
| Implicit TLS server | `SMTP_PORT=465` (or `SMTP_SECURE=true`) |

For Gmail you need 2-Step Verification and an **App Password** (https://myaccount.google.com/apppasswords); your normal password won't work. Gmail rewrites the From address to the authenticated account. Whenever a user is set, TLS is required. Set `SUPPORT_EMAIL_TO` to the inbox that should receive escalations.

## Operations

- **Create more agents:** `npm run create-agent -- <name> <password> [display name]`
- **Logs:** `docker compose logs -f backend`. By design they contain ids, tool names, timings, token counts and error classes only, never message text, prompts or tool arguments.
- **Reset everything (deletes all data):** `docker compose down -v && rm -rf data && bash scripts/init.sh`
- **Customer deletes a conversation:** the widget's *Delete* button calls `DELETE /api/customer/conversations/:roomId`; the room is purged with Synapse's Delete Room v2 admin API.

## Environment variable reference

`.env.example` is the template; `scripts/init.sh` fills the "auto" secrets.

| Variable | Purpose |
|---|---|
| `MATRIX_SERVER_NAME` | Matrix domain part (`chat.local`) |
| `MATRIX_PUBLIC_BASEURL` | Homeserver URL given to browsers (`http://localhost:8008`) |
| `AS_TOKEN`, `HS_TOKEN` | Appservice tokens (auto) |
| `SYNAPSE_REGISTRATION_SHARED_SECRET` | Lets `create-agent` register agents (auto) |
| `POSTGRES_PASSWORD` | DB password (auto) |
| `BACKEND_PORT`, `APPSERVICE_PORT` | REST port (3000) and appservice port (9000) |
| `BACKEND_JWT_SECRET` | Signs customer session tokens for the backend REST API (auto) |
| `ADMIN_API_TOKEN` | Protects `POST /api/admin/reload-config` (auto) |
| `CUSTOMER_AUTH_MODE` | `anonymous` (visitor id in localStorage) or `external_jwt` |
| `EXTERNAL_JWT_PUBLIC_KEY` | Verifies host-app JWTs (`sub` = customer reference), only for `external_jwt` |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | OpenAI-compatible endpoint, key and model |
| `AI_HISTORY_MESSAGES` | Messages of history sent to the model (30) |
| `AI_STREAM_EDIT_INTERVAL_MS` | Minimum gap between streamed message edits (1000) |
| `COMPANY_NAME` | Value for `{{company_name}}` in prompts |
| `DEFAULT_CUSTOMER_NAME`, `DEFAULT_CUSTOMER_EMAIL`, `DEFAULT_CUSTOMER_PHONE` | Used when the host page sends no details (`Test User`, `testuser@test.com`, `+9876543210`) |
| `ENABLE_E2EE` | Hook for later; keep `false` in v1 |
| `TOOLS_CONFIG_PATH`, `PROMPTS_DIR` | Locations of tool config and prompts |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Outgoing email |
| `SUPPORT_EMAIL_TO` | Recipient of email escalations |
| `WEBHOOK_SIGNING_SECRET` | HMAC key for outgoing webhook signatures (auto) |
| `TICKETS_API_TOKEN` | Used by the example `create_ticket` tool |

## Production TODO

- **TLS and domain:** Caddy is configured for local HTTP. Replace `:8008` in `caddy/Caddyfile` with your domain (Caddy then issues certificates), update `MATRIX_PUBLIC_BASEURL`, and don't publish Synapse's `8009` or Mailpit ports.
- **Azure/LLM hardening:** private endpoint/VNet, abuse-monitoring opt-out, key rotation, per-customer rate limits and cost caps.
- **Prompt content:** put real company facts in `backend/config/prompts/system.md`; the model will otherwise guess (it invented opening hours in testing).
- **Customer privacy:** the agent-only AI summary is a flagged notice in the shared room. The widget hides it, but a customer using the raw Matrix API could read it. Move to a separate agent-only channel if that matters.
- **Widget size:** `widget.js` is ~8.5 MB (2.9 MB gzipped) because `matrix-js-sdk` bundles its crypto WASM; lazy-load it or serve compressed.
- **Retention/compliance/backups:** Synapse retention is enabled but has no policy; no archiving; back up the Postgres volume and `data/synapse`.
- **E2EE, media, voice/video:** deliberately out of scope for v1 (`ENABLE_E2EE` and crypto-ready SDK init are in place).
- **Backend replicas:** assignment locking and fallback timers are in-process; run a single backend instance or move them to Postgres/Redis.
- **Test accounts:** remove `agent_alice` / `agent_bob` style test users and any default passwords before going live.
