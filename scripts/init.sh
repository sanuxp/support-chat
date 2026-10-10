#!/usr/bin/env bash
# First-run setup: .env + secrets, render Synapse config, start Postgres + Synapse,
# create the @svc_admin appservice user and promote it to server admin.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || cp .env.example .env

# fill empty secret values with random hex
gen() { openssl rand -hex 32; }
for key in AS_TOKEN HS_TOKEN SYNAPSE_REGISTRATION_SHARED_SECRET POSTGRES_PASSWORD BACKEND_JWT_SECRET ADMIN_API_TOKEN WEBHOOK_SIGNING_SECRET; do
  if grep -Eq "^${key}=[[:space:]]*(#.*)?$" .env; then
    sed -i -E "s|^${key}=[[:space:]]*(#.*)?$|${key}=$(gen)|" .env
    echo "generated $key"
  fi
done

# load .env (strip inline comments + CRs)
set -a
# shellcheck disable=SC1090
source <(sed -E 's/\r$//; s/[[:space:]]+#.*$//' .env | grep -E '^[A-Za-z_][A-Za-z0-9_]*=')
set +a

export MATRIX_SERVER_NAME_RE="${MATRIX_SERVER_NAME//./\.}"
export APPSERVICE_PORT="${APPSERVICE_PORT:-9000}"

render() { # render <template> <out>  — substitutes only the vars we know about
  local tpl="$1" out="$2" content
  content="$(cat "$tpl")"
  for v in MATRIX_SERVER_NAME MATRIX_SERVER_NAME_RE MATRIX_PUBLIC_BASEURL POSTGRES_PASSWORD \
           SYNAPSE_REGISTRATION_SHARED_SECRET AS_TOKEN HS_TOKEN APPSERVICE_PORT; do
    content="${content//\$\{$v\}/${!v}}"
  done
  printf '%s\n' "$content" > "$out"
}

mkdir -p data/synapse
render synapse/homeserver.yaml.template data/synapse/homeserver.yaml
render synapse/appservice-registration.yaml.template data/synapse/appservice-registration.yaml
cp synapse/log.config data/synapse/log.config
echo "rendered Synapse config into data/synapse/"

docker compose up -d postgres synapse
echo -n "waiting for Synapse"
for _ in $(seq 1 90); do
  if curl -fs http://localhost:8009/_matrix/client/versions >/dev/null 2>&1; then echo " ready"; break; fi
  echo -n "."; sleep 2
done
curl -fs http://localhost:8009/_matrix/client/versions >/dev/null || { echo "Synapse did not come up; see: docker compose logs synapse"; exit 1; }

# Create @svc_admin (appservice-exclusive user) and make it a server admin.
# Exclusive namespace users can't use shared-secret registration, so register via the AS token,
# then flip the admin flag in the DB (documented way: docs/usage/administration/admin_api/README.md).
code=$(curl -s -o /tmp/svc_admin.json -w '%{http_code}' -X POST http://localhost:8009/_matrix/client/v3/register \
  -H "Authorization: Bearer ${AS_TOKEN}" -H 'Content-Type: application/json' \
  -d '{"type":"m.login.application_service","username":"svc_admin"}')
if [ "$code" != "200" ] && ! grep -q M_USER_IN_USE /tmp/svc_admin.json; then
  echo "failed to register @svc_admin ($code):"; cat /tmp/svc_admin.json; exit 1
fi
docker compose exec -T postgres psql -U synapse -d synapse -c \
  "UPDATE users SET admin = 1 WHERE name = '@svc_admin:${MATRIX_SERVER_NAME}';"
echo "init complete. Next: docker compose up -d --build backend caddy mailpit"
