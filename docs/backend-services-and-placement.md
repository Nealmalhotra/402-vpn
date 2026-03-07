# Backend Services & Deployment Placement

This document describes each backend service required for the 402-VPN system and where it should run.

---

## Service Overview

| Service | Role | Where it lives | Depends on |
|---------|------|----------------|------------|
| **Redis** | Shared state: sessions, regions, IP pools, pub/sub | Central (one instance) | — |
| **API** | Public HTTP API: sessions, regions, fetch, 402 gates | Central (one deployment) | Redis |
| **Billing worker** | Deducts credit, evicts expired sessions, publishes eviction events | Central (co-located with API) | Redis |
| **Agent** | Applies WireGuard peer add/remove per region | **Per region** (one per region) | Redis, WireGuard on host |
| **Regional proxy** | Executes HTTP fetches from a region's IP (for proxy-mode sessions) | **Per region** (one per region) | — |

---

## Deployment Topology

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           CENTRAL (e.g. single VM / PaaS)                         │
│                                                                                   │
│   ┌─────────┐    ┌──────────────┐    ┌─────────────────┐                         │
│   │  Redis  │◄───│  API Server  │    │ Billing Worker   │                         │
│   │ :6379   │    │  :3000       │    │ (cron/daemon)    │                         │
│   └────▲────┘    └──────┬───────┘    └────────┬────────┘                         │
│        │                │                     │                                   │
│        │                │                     │ pub/sub peer_events:*             │
└────────┼────────────────┼─────────────────────┼───────────────────────────────────┘
         │                │                     │
         │                │                     │
    ┌────┴────────────────┴─────────────────────┴────┐
    │              Redis connection                   │
    │         (VPN tunnel / private net)              │
    └────┬────────────────────────────────┬─────────┘
         │                                │
         ▼                                ▼
┌─────────────────────┐          ┌─────────────────────┐
│  REGIONAL NODE      │          │  REGIONAL NODE      │
│  us-west (Vultr)    │          │  eu-central (Vultr)│
│                     │          │                     │
│  • Agent (Go)       │          │  • Agent (Go)       │
│  • Regional proxy   │          │  • Regional proxy   │
│    :3001            │          │    :3001            │
│  • WireGuard (wg0)  │          │  • WireGuard (wg0)  │
└─────────────────────┘          └─────────────────────┘
```

---

## 1. Redis

**Purpose:** Single source of truth for sessions, regions, IP pools, active peers, and pub/sub channels for peer events.

**Where:** One central instance. Can be:
- Docker Compose (local / small deployments)
- Managed Redis (Redis Cloud, ElastiCache, etc.)
- Dedicated VM with Redis

**Requirements:**
- Accessible from: API, billing worker, and **all** regional agents
- Agents need Redis for pub/sub (`peer_events:{region_id}`); use a private network or VPN so regional nodes can reach Redis securely

**Data stored:**
- `session:{id}`, `sessions:active`, `region:{id}`, `region:{id}:ip_pool`, `region:{id}:active_peers`
- Pub/sub: `peer_events:{region_id}`, `peer_events:ack`

---

## 2. API Server

**Purpose:** Public HTTP API. Handles:
- `GET /regions` — list regions and pricing
- `POST /session/create` — create session (402-gated)
- `POST /session/:id/topup` — add credit (402-gated)
- `GET /session/me`, `GET /session/:id/status` — session status
- `GET|POST /fetch` — proxy-mode: forward to regional proxy or local fallback
- `POST /regional/fetch` — **internal** endpoint for regional proxies (see below)

**Where:** Central deployment. One instance (or LB in front of replicas). Users and AI agents hit this.

**Requirements:**
- `REDIS_URL` pointing to central Redis
- For proxy mode: either `proxy_url` set per region (points to regional proxy) or `ALLOW_LOCAL_PROXY_FALLBACK=true` (fetches from API host; only valid if API runs in a region)
- For x402: `X402_ENABLED=true`, `X402_PAY_TO`, `X402_FACILITATOR_URL`, `X402_NETWORK`

**Config:** `api/src/config.js`, env from `.env.example`

---

## 3. Billing Worker

**Purpose:** Every `BILLING_TICK_SECONDS` (default 30s), scans active sessions, deducts credit, evicts sessions when credit reaches zero, publishes `PEER_EVICT` to `peer_events:{region_id}`.

**Where:** Central. Co-located with API (same VM or same k8s cluster). Must share Redis with API.

**Requirements:**
- `REDIS_URL` (same as API)
- Single instance recommended (multiple instances would double-debit; no locking today)

**Run:** `npm run start:billing`

---

## 4. Agent (Go)

**Purpose:** WireGuard peer management. Subscribes to `peer_events:{region_id}`, applies `wg set peer add/remove` for `PEER_ADD` and `PEER_EVICT` events.

**Where:** **One per region**, on the same host that runs WireGuard for that region. Must have `wg` binary and `wg0` (or configured interface) available.

**Requirements:**
- `REDIS_URL` (reaches central Redis)
- `AGENT_REGION` (e.g. `us-west`) — must match `region:{id}` in Redis
- Root or `CAP_NET_ADMIN` to run `wg`
- Use `AGENT_DRY_RUN=true` for local dev without real WireGuard

**Run:** `AGENT_REGION=us-west go run ./agent`

---

## 5. Regional Proxy

**Purpose:** For proxy-mode sessions, the API forwards `/fetch` requests to the region’s `proxy_url`. The regional proxy performs the HTTP request from that region’s egress IP so the target sees a regional IP.

**Where:** **One per region** that supports proxy mode. Runs on a host in that region (e.g. Vultr us-west, eu-central).

**What runs there:** The same `api/src/server.js` can be deployed in “proxy-only” mode; the only route that matters for the central API is `POST /regional/fetch`. Alternatively, a minimal service that only exposes that endpoint (using `performSafeFetch` from `api/src/fetchProxy.js`).

**Requirements:**
- Reachable from the central API (public URL or private network)
- `REGIONAL_PROXY_SHARED_SECRET` set on both API and regional proxy for auth
- Redis: **Not required** for the regional proxy itself; it only performs fetches

**Config in Redis:** Per region, set `proxy_url`:

```
region:us-west  →  proxy_url: http://<vultr-us-west-ip>:3001/regional/fetch
region:eu-central → proxy_url: http://<vultr-eu-ip>:3001/regional/fetch
```

---

## Summary: What Lives Where

| Component | Central | Per-Region |
|-----------|---------|------------|
| Redis | ✅ One | — |
| API | ✅ One | — |
| Billing | ✅ One | — |
| Agent | — | ✅ One per region |
| Regional proxy | — | ✅ One per region (proxy mode only) |
| WireGuard (wg0) | — | ✅ One per region (WireGuard mode only) |

---

## Local Development

- **Redis:** `docker compose up -d redis`
- **API + Billing:** Run locally; `ALLOW_LOCAL_PROXY_FALLBACK=true` so `/fetch` runs from your machine
- **Agent:** `AGENT_DRY_RUN=true` so it doesn’t need real WireGuard
- **Regional proxy:** Optional; can use a remote Vultr node and set `proxy_url` in Redis (as in `ex.sh`)

---

## Production Checklist

- [ ] Redis on private network or VPN; not publicly exposed
- [ ] API behind HTTPS + reverse proxy
- [ ] `SESSION_TOKEN_SECRET` and `REGIONAL_PROXY_SHARED_SECRET` set to strong random values
- [ ] x402: `X402_PAY_TO` and network configured
- [ ] Each region: Agent + Regional proxy (if proxy mode) + WireGuard (if WireGuard mode)
- [ ] Region `proxy_url` and `endpoint`/`public_key` populated in Redis for each region
