#!/usr/bin/env bash
set -Eeuo pipefail

# Standalone local run: no proxy, no shared Docker network, loopback port only.
# Plain `docker compose` automatically merges docker-compose.override.yml, which
# is where that host port lives.

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

compose=(docker compose --env-file .env)
"${compose[@]}" config --quiet
# --wait so this returns only once the app is healthy. The README documents no
# separate verification step and relies on that.
"${compose[@]}" up -d --build --remove-orphans --wait --wait-timeout 90
"${compose[@]}" ps

set -a
# shellcheck disable=SC1091
source .env
set +a
echo "App: http://localhost:${APP_PORT:-3081}"
