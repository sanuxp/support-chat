# widget — embeddable customer chat

A floating chat bubble that any website can embed with one `<script>` tag. React + `matrix-js-sdk`, built into a single self-contained `widget.js`, rendered inside a **Shadow DOM** so the host page's CSS can't affect it (and vice versa).

Big picture: [`../docs/DEVELOPER_GUIDE.md`](../docs/DEVELOPER_GUIDE.md).

## Embedding

```html
<script src="https://your-host/widget.js"></script>
<script>
  SupportChat.init({
    backendUrl: "https://your-host",   // where /api/* and Matrix are served (Caddy origin)
    authToken: null,                   // host-app JWT when the backend runs CUSTOMER_AUTH_MODE=external_jwt
    title: "Support"                   // optional header text
  });
  // SupportChat.destroy() removes it
</script>
```

`init` is idempotent. `public/index.html` is a demo host page (deliberately styled with a serif font to prove CSS isolation); it is copied into `dist/` and served at `http://localhost:8008/`.

## Develop and build

```bash
cd widget
npm install
npm run dev        # http://localhost:5173 — uses the root index.html and talks to Caddy on :8008
npm run build      # typecheck + vite library build → dist/widget.js (IIFE) and dist/index.html
npm run typecheck
```

Caddy serves `widget/dist` straight from disk, so after `npm run build` just refresh http://localhost:8008/ — no container restart.

Build-time flag: `VITE_ENABLE_E2EE=true` makes `connect()` call `client.initRustCrypto()`. It is off in v1 and untested.

## Files (`src/`)

| File | Responsibility |
|---|---|
| `embed.ts` | Public entry. Creates the host element + shadow root, injects `widget.css` (imported with `?inline`), mounts React, exposes `window.SupportChat` |
| `ChatWidget.tsx` | The whole UI and state: open/close, lazy connect on first open, message list, send, typing indicator, hand-off status banners, delete-with-confirm, "new conversation" after close |
| `matrixClient.ts` | `createSession` (calls `POST /api/customer/session`, persists `visitorId` in `localStorage`), `connect` (creates the Matrix client with the issued token and waits for the first sync), `deleteConversation` |
| `widget.css` | Styles (scoped by the shadow root) |
| `env.d.ts` | Vite and `?inline` typings |

## How it behaves

- **Lazy start:** nothing connects until the user opens the bubble.
- **Identity:** the first session gets a `visitorId` UUID stored in `localStorage`; later page loads reuse it, so the same conversation (and history) comes back.
- **One room only.** The room id comes from the session response.
- **Rendering rules** (`toLines`): shows `m.room.message` events only; skips edit events (the SDK already applies edits to the original, so streamed AI replies update in place); **hides notices flagged `com.supportchat.internal`** (agent-only summaries); shows other `m.notice` as centered italic system text; shows "Agent <name> joined" when a `@agent_*` user joins.
- **Status:** reads the `com.supportchat.handoff` state; `waiting` shows "Waiting for a team member to join…", `closed` shows "This conversation has ended" and a "Start a new conversation" button.
- **Delete:** the header's *Delete* → confirm → `DELETE /api/customer/conversations/:roomId` → a fresh session/room.
- The widget talks to Synapse directly (messages, sync) and to the backend only for session and delete. Cross-origin use works because Synapse and the backend both send CORS headers.

## Gotchas

- Bundle size is ~8.5 MB (≈2.9 MB gzipped): `matrix-js-sdk` pulls in its crypto WASM even with E2EE off. Lazy-loading or compression is a production TODO.
- `npm` installs `matrix-js-sdk` 37.x; `../vendor/matrix-js-sdk` is a newer develop checkout used only for reading source — check APIs against the installed `node_modules` version.
- Don't render message bodies as HTML; they are plain text (React escapes them). Keep it that way.
- Tested by `npm run e2e:ui` (from the repo root) and manually via the demo page.
