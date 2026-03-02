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

## API Endpoints

- `GET /regions`
- `POST /session/create` *(x402-gated)*
- `POST /session/:id/topup` *(x402-gated)*
- `GET /session/:id/status`

## Notes

- Minimum purchase at create-time is enforced via `MIN_CREATE_MINUTES` (default: 10).
- `/session/create` has per-IP hourly rate limiting (`CREATE_RATE_LIMIT_PER_IP_PER_HOUR`, default: 10).
- Billing worker evicts sessions whose credit reaches zero and sets a 24-hour TTL on evicted session records.
- Agent supports `AGENT_DRY_RUN=true` for development without calling `wg`.