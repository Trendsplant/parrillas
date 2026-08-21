#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

dump_file="${1:-}"
confirmation="${2:-}"
if [[ -z "$dump_file" || "$confirmation" != "--confirm-replace" ]]; then
  echo "Uso: $0 backups/postgres/parrillas-YYYYMMDDTHHMMSSZ.dump --confirm-replace" >&2
  exit 2
fi
if [[ ! -f "$dump_file" ]]; then
  echo "No existe el dump: $dump_file" >&2
  exit 2
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${POSTGRES_USER:=parrillas}"
: "${POSTGRES_DB:=parrillas}"

restart_app() {
  docker compose start app >/dev/null 2>&1 || true
}
trap restart_app EXIT

docker compose stop app
docker compose exec -T db pg_restore \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --clean --if-exists --no-owner --no-acl \
  < "$dump_file"
docker compose exec -T db psql \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --command="ANALYZE;"

restart_app
trap - EXIT
echo "Restauración completada desde: $dump_file"

