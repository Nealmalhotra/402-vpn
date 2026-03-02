#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REDIS_URL="redis://127.0.0.1:6379"

echo "[setup] Installing Node dependencies from package-lock.json"
npm ci

echo "[setup] Downloading Go dependencies for /agent"
(
  cd agent
  go mod download
)

echo "[setup] Checking system tooling"
if command -v docker >/dev/null 2>&1; then
  echo "  - docker: $(docker --version)"
  if docker compose version >/dev/null 2>&1; then
    echo "  - docker compose: $(docker compose version)"
  else
    echo "  - docker compose: missing (install Docker Compose plugin)"
  fi
else
  echo "  - docker: missing"
  echo "  - docker compose: missing (docker missing)"
fi

if command -v redis-server >/dev/null 2>&1; then
  echo "  - redis-server: $(redis-server --version)"
else
  echo "  - redis-server: missing"
fi

if command -v redis-cli >/dev/null 2>&1; then
  echo "  - redis-cli: $(redis-cli --version)"
else
  echo "  - redis-cli: missing"
fi

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "[setup] Created .env from .env.example"
  else
    : > .env
    echo "[setup] Created empty .env"
  fi
fi

if ! rg "^REDIS_URL=" .env >/dev/null 2>&1; then
  printf "\nREDIS_URL=%s\n" "$DEFAULT_REDIS_URL" >> .env
  echo "[setup] Added REDIS_URL default to .env"
else
  echo "[setup] REDIS_URL already present in .env"
fi

echo "[setup] Done"
