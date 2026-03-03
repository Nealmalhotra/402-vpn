# AGENTS.md

## Cursor Cloud specific instructions

This is an x402-gated pay-per-minute VPN control plane (Node.js API + billing worker + Go regional agent). All services communicate through Redis.

### Architecture

- **Control plane** (this repo): API server, billing worker. Connects to hosted Redis.
- **Regional nodes** (e.g. Vultr servers): `agent/regional-proxy.js` (lightweight HTTP proxy, zero npm deps) + compiled Go agent binary. The Go agent connects to Redis for WireGuard peer events via pub/sub.

### Services overview

| Service | Command | Notes |
|---------|---------|-------|
| Redis | Upstash (hosted) or `docker compose up -d redis` (local dev) | Must be reachable before any other service |
| API server | `REDIS_URL="$REDIS_URL" node api/src/server.js` | Port 3000. Auto-seeds regions if `AUTO_SEED_REGIONS=true` (default) |
| Billing worker | `REDIS_URL="$REDIS_URL" node billing/src/worker.js` | Ticks every 30 s; deducts credit, evicts expired sessions |
| Regional proxy | `node agent/regional-proxy.js` | Runs on regional nodes. Zero deps, serves `/regional/fetch` only |
| Go agent | `cd agent && AGENT_REGION=us-west AGENT_DRY_RUN=true go run .` | Runs on regional nodes. Dry-run mode skips actual WireGuard calls |

### Gotchas

- **REDIS_URL and npm scripts**: The npm scripts in `package.json` contain `REDIS_URL=${REDIS_URL:-redis://localhost:6379}` shell defaults. If using a hosted Redis (e.g. Upstash), you must pass `REDIS_URL` as an env var inline (`REDIS_URL="rediss://..." node api/src/server.js`) — the `.env` file alone won't override the shell default.
- **Upstash Redis URL**: Construct from REST credentials: `rediss://default:<UPSTASH_REDIS_REST_TOKEN>@<hostname from UPSTASH_REDIS_REST_URL>:6379`.
- **Docker daemon**: In the Cloud VM, Docker requires `sudo dockerd` to start, and the socket at `/var/run/docker.sock` needs `sudo chmod 666` for non-root access. Only needed if using local Redis instead of Upstash.
- **Go agent**: Run from the `agent/` directory (`cd agent && go run .`) to avoid Go module resolution issues.
- **x402 payments are disabled** by default (`X402_ENABLED=false` in `.env`), so all endpoints work without blockchain infrastructure.
- **Unit tests** (`npm test`) are pure logic tests — they do **not** require Redis or any running services.
- **`.env` file**: Created from `.env.example` by `npm run setup:dev`. If missing, copy it manually: `cp .env.example .env`.

### Regional node setup

A regional node only needs two files from this repo:
1. `agent/regional-proxy.js` — standalone HTTP proxy (Node.js, zero npm deps)
2. Compiled Go agent binary (`cd agent && go build -o agent-bin .`)

Start them with:
```bash
node regional-proxy.js                              # serves /regional/fetch on :3000
AGENT_REGION=us-west REDIS_URL="..." ./agent-bin    # WireGuard peer management
```

Then set the region's `proxy_url` in Redis:
```
HSET region:us-west proxy_url http://<node-ip>:3000/regional/fetch
```

### Standard commands

See `README.md` for full endpoint documentation and `package.json` `scripts` for all available npm commands.
