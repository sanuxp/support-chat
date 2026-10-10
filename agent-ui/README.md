# agent-ui — human agent console

A React app for support staff. They sign in with their Matrix account, go **Online**, see the queue, take conversations and chat with customers in the same room the AI was using.

Big picture: [`../docs/DEVELOPER_GUIDE.md`](../docs/DEVELOPER_GUIDE.md).

## Use it

1. Create an account once: from the repo root, `npm run create-agent -- alice 'password' 'Alice'` (becomes `@agent_alice:chat.local`).
2. Open http://localhost:8008/agent/ and sign in as `agent_alice`.
3. Click **Offline → Online**. Only online agents are assigned conversations.
4. Click a conversation, read the highlighted **AI summary**, reply. Finish with **Resolve → back to AI** or **Resolve & close**.

## Develop and build

```bash
cd agent-ui
npm install
npm run dev        # http://localhost:5174/agent/  (backend + Synapse via Caddy on :8008)
npm run build      # typecheck + vite build → dist/ (served by Caddy at /agent/)
npm run typecheck
```

Vite `base` is `/agent/` in dev and build. In production the console is on the same origin as Synapse and the backend; override with `VITE_HOMESERVER_URL` / `VITE_BACKEND_URL` if they differ. With `vite dev` (port 5174) both default to `http://localhost:8008`.

## Files (`src/`)

| File | Responsibility |
|---|---|
| `main.tsx` | React entry |
| `App.tsx` | Session, Matrix client lifecycle, **presence heartbeat** (`POST /api/agent/presence` every 30 s while Online), queue refresh (5 s poll + refetch on any `com.supportchat.handoff` state change), sign-out |
| `Login.tsx` | Username/password form |
| `Queue.tsx` | "My conversations" and "Waiting" lists with reason + AI summary preview |
| `ConversationView.tsx` | Opens a conversation: `accept` → `joinRoom` → paginate back through history → live timeline → send box → resolve buttons |
| `matrixClient.ts` | `login` (`m.login.password`), `startClient`, session persistence in `localStorage`, auto-join of invites, `api()` helper that calls the backend with the agent's Matrix token |
| `styles.css` | Styling |

## How it works

- **Auth:** the agent's own Matrix access token is also the bearer token for the backend's `/api/agent/*` endpoints; the backend verifies it with Synapse (`whoami`) and requires an `@agent_*` user.
- **Assignment reaches the console in two ways:** the backend *invites* the agent to the room (the client auto-joins invites), and the conversation shows up in `GET /api/agent/conversations`.
- **Opening a chat:** `accept` is idempotent — it assigns a waiting chat to you (respecting your `max_concurrent`, default 3), or just re-invites you if it is already yours. Then the client joins and paginates back (`history_visibility: shared`, so earlier customer–AI messages are visible).
- **Message styling:** AI summary = amber card (`com.supportchat.internal` notice); notices = grey italics; you = blue; customer / AI / other agents = light bubbles.
- **After you resolve:** the backend kicks you from the room; the console returns to the queue. If you are no longer assigned, the composer disables itself.
- **Closing the tab** stops the heartbeat; the backend treats an agent as offline 90 s after the last beat.

## Gotchas

- Agents can't change hand-off state themselves (power level 0); all state changes go through the backend.
- The queue list can be one poll stale; `accept` handles that race.
- Tested end-to-end by `npm run e2e:ui` (repo root).
- Not implemented (ideas): typing indicators for agents, unread counts, notifications/sounds, per-agent settings (`max_concurrent` is a DB column only), canned replies, conversation history search.
