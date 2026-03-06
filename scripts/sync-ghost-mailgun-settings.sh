#!/usr/bin/env bash
set -euo pipefail

BRIDGE_SERVICE="${BRIDGE_SERVICE:-ghost-mail-bridge}"
MAILGUN_BASE_URL="${MAILGUN_BASE_URL:-http://${BRIDGE_SERVICE}:3003/v3}"
BRIDGE_ENV_FILE="${BRIDGE_ENV_FILE:-.env}"
RESTART_GHOST="${RESTART_GHOST:-1}"

print_err() {
  printf '%s\n' "$*" >&2
}

detect_container() {
  local service="$1"
  docker ps \
    --filter "label=com.docker.compose.service=${service}" \
    --format '{{.Names}}' | head -n 1
}

read_bridge_env_value() {
  local key="$1"

  if [ ! -f "$BRIDGE_ENV_FILE" ]; then
    return 1
  fi

  grep -E "^${key}=" "$BRIDGE_ENV_FILE" | tail -n 1 | cut -d= -f2-
}

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

if ! command -v docker >/dev/null 2>&1; then
  print_err 'docker is required'
  exit 1
fi

GHOST_CONTAINER="${GHOST_CONTAINER:-$(detect_container ghost)}"
DB_CONTAINER="${DB_CONTAINER:-$(detect_container db)}"

if [ -z "$GHOST_CONTAINER" ]; then
  print_err 'Could not detect the Ghost container. Set GHOST_CONTAINER explicitly.'
  exit 1
fi

if [ -z "$DB_CONTAINER" ]; then
  print_err 'Could not detect the database container. Set DB_CONTAINER explicitly.'
  exit 1
fi

DB_CLIENT="$(docker exec "$GHOST_CONTAINER" printenv database__client || true)"
DB_NAME="$(docker exec "$GHOST_CONTAINER" printenv database__connection__database || true)"
DB_USER="$(docker exec "$GHOST_CONTAINER" printenv database__connection__user || true)"
DB_PASSWORD="$(docker exec "$GHOST_CONTAINER" printenv database__connection__password || true)"
CURRENT_BULK_ENV="$(docker exec "$GHOST_CONTAINER" printenv bulkEmail__mailgun__baseUrl || true)"

if [ "$DB_CLIENT" != "mysql" ]; then
  print_err "Unsupported Ghost database client: ${DB_CLIENT:-<empty>}"
  exit 1
fi

if [ -z "$DB_NAME" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ]; then
  print_err 'Could not read Ghost database credentials from the Ghost container.'
  exit 1
fi

PROXY_API_KEY="${PROXY_API_KEY:-$(read_bridge_env_value PROXY_API_KEY || true)}"
MAILGUN_DOMAIN="${MAILGUN_DOMAIN:-$(read_bridge_env_value MAILGUN_DOMAIN || true)}"

if [ -z "$PROXY_API_KEY" ] || [ -z "$MAILGUN_DOMAIN" ]; then
  print_err "Could not read PROXY_API_KEY or MAILGUN_DOMAIN from ${BRIDGE_ENV_FILE}."
  print_err 'Set PROXY_API_KEY and MAILGUN_DOMAIN explicitly in the shell and rerun.'
  exit 1
fi

if [ -n "$CURRENT_BULK_ENV" ]; then
  printf 'Ghost already has bulkEmail__mailgun__baseUrl set in env/config: %s\n' "$CURRENT_BULK_ENV"
  printf 'This script updates Ghost'\''s stored Mailgun settings for migration compatibility.\n'
fi

SQL=$(cat <<SQL
UPDATE settings SET value='$(sql_escape "$MAILGUN_BASE_URL")' WHERE \`key\`='mailgun_base_url';
UPDATE settings SET value='$(sql_escape "$PROXY_API_KEY")' WHERE \`key\`='mailgun_api_key';
UPDATE settings SET value='$(sql_escape "$MAILGUN_DOMAIN")' WHERE \`key\`='mailgun_domain';
SELECT \`key\`, value FROM settings WHERE \`key\` IN ('mailgun_base_url', 'mailgun_api_key', 'mailgun_domain');
SQL
)

docker exec "$DB_CONTAINER" \
  mysql "-u${DB_USER}" "-p${DB_PASSWORD}" "$DB_NAME" -e "$SQL"

if [ "$RESTART_GHOST" = "1" ]; then
  docker restart "$GHOST_CONTAINER" >/dev/null
  printf 'Restarted Ghost container: %s\n' "$GHOST_CONTAINER"
fi

printf 'Updated Ghost stored Mailgun settings to use %s\n' "$MAILGUN_BASE_URL"
