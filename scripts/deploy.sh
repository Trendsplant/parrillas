#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  echo "Falta $repo_dir/.env" >&2
  exit 2
fi

docker compose config --quiet
docker compose pull db caddy
docker compose build --pull app
docker compose up -d --remove-orphans

for attempt in {1..30}; do
  if docker compose exec -T app node -e \
    "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
    docker compose ps
    echo "Parrillas desplegado correctamente."
    exit 0
  fi
  sleep 2
done

docker compose logs --tail=100 app
echo "El healthcheck no respondió a tiempo." >&2
exit 1

