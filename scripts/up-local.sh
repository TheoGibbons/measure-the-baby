#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  cp .env.traefik.example .env
fi

if ! docker network inspect traefik-public >/dev/null 2>&1; then
  echo "The traefik-public network is missing. Start hobby-traefik locally first." >&2
  exit 1
fi

compose=(docker compose --env-file .env -f docker-compose.yml -f docker-compose.traefik.yml)
"${compose[@]}" config --quiet
"${compose[@]}" up -d --build --remove-orphans --wait --wait-timeout 90
"${compose[@]}" ps
