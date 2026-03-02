# x402-Gated Pay-Per-Minute VPN (MVP Scaffold)

This repository implements an MVP control plane for the PRD:

- **`api/`**: Express API with x402-gated session creation/topups
- **`billing/`**: 30-second billing worker that deducts credit and evicts peers
- **`control/`**: Shared Redis data model + key/session/region helpers
- **`agent/`**: Go regional daemon that applies WireGuard peer events

## Data Model (Redis)

- `session:{session_id}` (hash)
- `sessions:active` (set)
- `region:{region_id}` (hash)
- `region:{region_id}:ip_pool` (set)
- `region:{region_id}:active_peers` (set)
- `peer_events:{region_id}` (pub/sub channel)
- `peer_events:ack` (pub/sub channel)

## Local Run

### 1) Bootstrap local environment

```bash
npm run setup:dev
```

This command:

- Installs Node dependencies from `package-lock.json`
- Runs `go mod download` for `agent/`
- Checks for Docker + Docker Compose + Redis tooling
- Ensures `.env` contains `REDIS_URL=redis://127.0.0.1:6379`

### 2) Start Redis

```bash
docker compose up -d redis
```

### 3) Configure environment (optional if setup already created `.env`)

```bash
cp .env.example .env
```

> `X402_ENABLED=false` in `.env.example` lets you run locally without on-chain payments.
> Set `X402_ENABLED=true` plus `X402_PAY_TO` to enforce payment gates.

### 4) Seed regions

```bash
npm run seed:regions
```

### 5) Run services

Terminal A:

```bash
npm run start:api
```

Terminal B:

```bash
npm run start:billing
```

Terminal C (regional agent in dry-run mode):

```bash
AGENT_REGION=us-west AGENT_DRY_RUN=true go run ./agent
```

If your local Go toolchain still reports module lookup errors from repo root, run:

```bash
cd agent && AGENT_REGION=us-west AGENT_DRY_RUN=true go run .
```

## API Endpoints

- `GET /regions`
- `POST /session/create` *(x402-gated)*
- `POST /session/:id/topup` *(x402-gated)*
- `GET /session/me` *(Bearer token)*
- `GET /session/:id/status`
- `GET|POST /fetch` *(Bearer token, proxy-mode only)*
- `POST /regional/fetch` *(internal regional proxy endpoint)*

### Session modes

- `mode=proxy` (default): no WireGuard keys needed; returns a bearer token for `/fetch`.
- `mode=wireguard`: existing behavior; requires `public_key` and returns `wireguard_config`.

Proxy-mode create request:

```json
{
  "region": "us-west",
  "minutes": 15,
  "mode": "proxy"
}
```

Proxy-mode create response:

```json
{
  "token": "v1....",
  "session_id": "uuid",
  "region": "us-west",
  "mode": "proxy",
  "credit_seconds": 900,
  "expires_at": 1735689600
}
```

Proxy fetch request:

```bash
curl -X POST http://localhost:3000/fetch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","method":"GET"}'
```

## Notes

- Minimum purchase at create-time is enforced via `MIN_CREATE_MINUTES` (default: 10).
- `/session/create` has per-IP hourly rate limiting (`CREATE_RATE_LIMIT_PER_IP_PER_HOUR`, default: 10).
- `/fetch` has per-session per-minute rate limiting (`FETCH_RATE_LIMIT_PER_SESSION_PER_MINUTE`, default: 60).
- Proxy fetch enforces SSRF protections (blocks internal/private destinations), response size limit, and request timeout.
- Billing worker evicts sessions whose credit reaches zero and sets a 24-hour TTL on evicted session records.
- Agent supports `AGENT_DRY_RUN=true` for development without calling `wg`.