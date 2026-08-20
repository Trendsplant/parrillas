#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${POSTGRES_USER:=parrillas}"
: "${POSTGRES_DB:=parrillas}"
: "${BACKUP_RETENTION_DAYS:=14}"

backup_dir="$repo_dir/backups/postgres"
mkdir -p "$backup_dir"
backup_file="$backup_dir/parrillas-$(date -u +%Y%m%dT%H%M%SZ).dump"

docker compose exec -T db pg_dump \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --format=custom --no-owner --no-acl > "$backup_file"

find "$backup_dir" -type f -name 'parrillas-*.dump' -mtime "+$BACKUP_RETENTION_DAYS" -delete
echo "Backup creado: $backup_file"

