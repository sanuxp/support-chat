# Infrastructure — Synapse, Postgres, Caddy, Docker

Everything that isn't our own code: configs in `synapse/`, `caddy/`, `postgres/` and `docker-compose.yml`. Big picture: [`../docs/DEVELOPER_GUIDE.md`](../docs/DEVELOPER_GUIDE.md).

## docker-compose services

| Service | Image | Notes |
|---|---|---|
| `postgres` | `postgres:16` | Initialised with `--lc-collate=C --lc-ctype=C` (Synapse requires C collation). User `synapse`; DB `synapse` from `POSTGRES_DB`, DB `support_backend` created by `postgres/init.sql` on first start |
| `synapse` | `matrixdotorg/synapse:v1.162.0` | Reads `/data` = `./data/synapse` (rendered config, signing key, media). Published only on `127.0.0.1:8009` |
| `backend` | built from `./backend` | `env_file: .env`; compose adds `SYNAPSE_URL` and `DATABASE_URL`; bind-mounts `./backend/config` |
| `caddy` | `caddy:2` | Public entry point on `:8008`; serves `widget/dist` at `/` and `agent-ui/dist` at `/agent/` |
| `mailpit` | `axllent/mailpit` | Fake SMTP (`1025`) with a web inbox (`8025`) |

Volume `pgdata` holds the databases. `data/` (gitignored) holds generated Synapse files.

## How configuration is generated

`scripts/init.sh` renders templates with a small bash substitution (only known variables, so Synapse's own `${...}` is untouched):

- `synapse/homeserver.yaml.template` → `data/synapse/homeserver.yaml`
- `synapse/appservice-registration.yaml.template` → `data/synapse/appservice-registration.yaml`
- `synapse/log.config` is copied as is.

**Change a Synapse setting:** edit the template, run `bash scripts/init.sh` (idempotent), then `docker compose restart synapse`. Don't hand-edit files in `data/` — they are overwritten.

### Key Synapse settings and why

| Setting | Why |
|---|---|
| `enable_registration: false` | Nobody can self-register; users are created by the appservice or the admin shared secret |
| `federation_domain_whitelist: []` | Federation off — this server talks to nobody else |
| `url_preview_enabled: false` | No outbound fetches on behalf of chat content |
| `encryption_enabled_by_default_for_room_type: "off"` | v1 has no E2EE (the AI must read messages) |
| `push.include_content: false` | Keep content out of push notifications |
| `retention.enabled: true` | Switch is on; no policy is set yet (add `default_policy` later) |
| `registration_shared_secret` | Lets `create-agent` register agents through the admin API |
| `app_service_config_files` | Loads our appservice registration |
| `rc_message`, `rc_login` relaxed | Local dev and tests send many messages/logins quickly — review for production |

The default room version in Synapse 1.162 is 12; our backend explicitly creates **version 11** rooms (see the guide's gotchas).

### The appservice registration

`id: support-backend`, `sender_localpart: ai_agent`, `rate_limited: false`, exclusive user namespaces `@customer_.*` and `@svc_admin`. Synapse pushes room events to `http://backend:9000`; the tokens (`AS_TOKEN`, `HS_TOKEN`) come from `.env`. Human agents are **not** in this namespace (they are normal accounts that log in themselves).

## Caddy (`caddy/Caddyfile`)

```
:8008 {
  /_matrix/*  → synapse:8008
  /api/*      → backend:$BACKEND_PORT
  /agent/*    → static agent-ui/dist  (SPA fallback to index.html)
  everything else → static widget/dist (demo page + widget.js)
}
```

Auto-HTTPS is off for local use. **Going to a real domain:** replace `:8008` with the domain name (Caddy then provisions certificates), set `MATRIX_PUBLIC_BASEURL` to the https URL, keep `8009` and Mailpit private.

## Common operations

```bash
docker compose ps
docker compose logs -f synapse
docker compose exec postgres psql -U synapse -d synapse            # Synapse DB
docker compose exec postgres psql -U synapse -d support_backend    # backend DB
curl localhost:8009/_matrix/client/versions                        # Synapse is up?
docker compose down -v && rm -rf data && bash scripts/init.sh      # nuke everything and start over (DELETES DATA)
```

**Upgrading Synapse:** bump the tag in `docker-compose.yml`, read the upgrade notes in `vendor/synapse/docs/upgrade.md` (and re-check `docs/usage/configuration/config_documentation.md` for renamed options), `docker compose pull synapse && docker compose up -d synapse`. Re-run the smoke test.

**Admin API:** reachable at `http://localhost:8009/_synapse/admin/...` with a server admin's token. `@svc_admin` is the only admin; get its token with an appservice login (`POST /_matrix/client/v3/login` using `AS_TOKEN` and `{"type":"m.login.application_service","identifier":{"type":"m.id.user","user":"svc_admin"}}`).

## Backups and production notes

Back up the `pgdata` volume and `data/synapse` (the **signing key** and media). Production TODOs (TLS/domain, rate limits, retention policy, private networking) are listed in the root README.
