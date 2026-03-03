# AGENTS.md

## Cursor Cloud specific instructions

This is an x402-gated pay-per-minute VPN control plane (Node.js API + billing worker + Go regional agent). All services communicate through Redis.

### Services overview

| Service | Command | Notes |
|---------|---------|-------|
| Redis | `docker compose up -d redis` | Must be running before any other service |
| API server | `npm run start:api` | Port 3000. Auto-seeds regions if `AUTO_SEED_REGIONS=true` (default) |
| Billing worker | `npm run start:billing` | Ticks every 30 s; deducts credit, evicts expired sessions |
| Go agent | `cd agent && AGENT_REGION=us-west AGENT_DRY_RUN=true go run .` | Regional daemon; dry-run mode skips actual WireGuard calls |

### Gotchas

- **Docker daemon**: In the Cloud VM, Docker requires `sudo dockerd` to start, and the socket at `/var/run/docker.sock` needs `sudo chmod 666` for non-root access. The daemon is already running after environment setup.
- **Go agent**: Run from the `agent/` directory (`cd agent && go run .`) to avoid Go module resolution issues.
- **x402 payments are disabled** by default (`X402_ENABLED=false` in `.env`), so all endpoints work without blockchain infrastructure.
- **Unit tests** (`npm test`) are pure logic tests — they do **not** require Redis or any running services.
- **`.env` file**: Created from `.env.example` by `npm run setup:dev`. If missing, copy it manually: `cp .env.example .env`.

### Standard commands

See `README.md` for full endpoint documentation and `package.json` `scripts` for all available npm commands.
