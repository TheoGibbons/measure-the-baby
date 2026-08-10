#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  echo "Missing $repo_dir/.env; copy .env.production.example and set APP_HOST." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to deploy over tracked changes in $repo_dir" >&2
  exit 1
fi

git pull --ff-only

if ! docker network inspect traefik-public >/dev/null 2>&1; then
  echo "The traefik-public network is missing. Deploy hobby-traefik first." >&2
  exit 1
fi

compose=(docker compose --env-file .env -f docker-compose.yml -f docker-compose.traefik.yml -f docker-compose.prod.yml)
"${compose[@]}" config --quiet
"${compose[@]}" up \
  -d --build --remove-orphans --wait --wait-timeout 90
"${compose[@]}" ps
