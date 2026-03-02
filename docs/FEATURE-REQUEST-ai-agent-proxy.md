# Feature Request: AI-Agent-Friendly Proxy API

## Summary

Add an HTTP proxy API that allows AI agents to route traffic through regional nodes without installing WireGuard or managing keypairs. Users pay via 402, receive an ephemeral token, and make HTTP requests that execute from the chosen region.

## Motivation

AI agents need to:
- Fetch URLs or call APIs from specific geographic regions
- Do this with minimal setup (no native apps, no key generation)
- Pay on-demand (402 fits this model)
- Use simple HTTP—headers and body only

The current WireGuard-based flow requires client keypairs and native WireGuard installation, which is impractical for agents running in sandboxes or serverless environments.

---

## Proposed APIs

### 1. Session Creation (402-Gated)

**Endpoint:** `POST /session/create`

**Request (when x402 enabled, returns 402):**
```json
{
  "region": "us-west",
  "minutes": 15,
  "mode": "proxy"
}
```

| Field   | Type   | Required | Description                                        |
|---------|--------|----------|----------------------------------------------------|
| region  | string | yes      | Region id (e.g. `us-west`, `eu-central`)           |
| minutes | number | yes      | Credit duration (min: `MIN_CREATE_MINUTES`)       |
| mode    | string | no       | `"proxy"` (default for new flow) or `"wireguard"`  |

**Response (after payment):**
```json
{
  "token": "ephemeral_abc123...",
  "session_id": "uuid",
  "region": "us-west",
  "credit_seconds": 900,
  "expires_at": 1735689600,
  "mode": "proxy"
}
```

For `mode: "wireguard"`, the existing response shape (wireguard_config, public_key, etc.) is retained.

**Token format:** Signed JWT or HMAC-signed opaque string containing `session_id`, `region`, `expires_at`. Valid for bearer auth on proxy endpoints. Short-lived or single-use if desired for extra security.

---

### 2. Proxy Fetch (Token-Authenticated)

**Endpoint:** `POST /fetch` or `GET /fetch`

**Headers:**
```
Authorization: Bearer <token>
Content-Type: application/json  (for POST)
```

**POST body (or query params for GET):**
```json
{
  "url": "https://example.com/api/data",
  "method": "GET",
  "headers": { "X-Custom": "value" },
  "body": null
}
```

| Field   | Type   | Required | Description                          |
|---------|--------|----------|--------------------------------------|
| url     | string | yes      | URL to fetch                         |
| method  | string | no       | HTTP method (default: GET)           |
| headers | object | no       | Request headers to forward            |
| body    | string | no       | Request body (for POST/PUT/PATCH)    |

**Response:**
- Success: Forward the upstream response (status, headers, body). Optionally normalize to a standard envelope:
  ```json
  {
    "status": 200,
    "headers": { "content-type": "text/html" },
    "body": "<html>...",
    "fetched_from": "us-west"
  }
  ```
- 401: Invalid or expired token
- 402: Session out of credit (could allow topup flow)
- 403: Session evicted or not found
- 5xx: Upstream fetch failed

**Behavior:** The API routes the request to the regional proxy server. That server performs the HTTP request; the target sees the regional server’s IP as the client. Response is returned to the caller.

---

### 3. Session Status (Existing, Extend)

**Endpoint:** `GET /session/:id/status`

Extend to indicate mode and support token-based lookup:

- `GET /session/me` with `Authorization: Bearer <token>` → resolve session from token, return status.
- Response includes `mode: "proxy" | "wireguard"` when relevant.

---

## Implementation Modes

### Option A: Proxy-Only

**Scope:** No WireGuard; sessions are proxy-only.

| Component     | Change                                                                 |
|---------------|------------------------------------------------------------------------|
| Session       | `mode=proxy` only. No `public_key`, no WireGuard config.               |
| Token         | Issued on session create; used for `/fetch`.                         |
| Regional node | Runs HTTP proxy service only. No WireGuard, no agent peer management. |
| Billing       | Same as today: deduct by time; evict when credit is zero.              |
| Redis         | Session stores `mode`, `token` (or token derived from session).        |

**Pros:** Simpler, no WireGuard on nodes, faster to ship.
**Cons:** No full-tunnel VPN; only HTTP(S) proxy.

---

### Option B: Hybrid (Proxy + WireGuard)

**Scope:** Support both proxy and WireGuard for the same product.

| Component     | Change                                                                 |
|---------------|------------------------------------------------------------------------|
| Session       | `mode` = `"proxy"` or `"wireguard"`.                                   |
| Create        | Proxy: no `public_key`. WireGuard: requires `public_key`, returns config. |
| Token         | Proxy: required for `/fetch`. WireGuard: optional (e.g. for status).  |
| Regional node | Runs both: HTTP proxy + WireGuard + existing agent.                    |
| Agent         | Unchanged for WireGuard; add proxy service or integrate with API.      |

**Flow:**
1. `mode=proxy` → create session, return token. No peer in WireGuard.
2. `mode=wireguard` → create session, return WireGuard config. Agent adds peer as today.
3. `/fetch` checks token, resolves session, routes to regional proxy. Rejects if `mode=wireguard` (or allow both; proxy traffic never uses WireGuard).

**Pros:** One product for proxy (agents) and full VPN (humans).
**Cons:** More surface area; need to route proxy traffic to the correct region.

---

## Architecture (Proxy Path)

```
┌─────────────┐     POST /session/create      ┌─────────────┐
│  AI Agent   │ ─────────────────────────────►│     API     │
│             │  (402 pay → token)             │  (Express)  │
└─────────────┘                               └──────┬──────┘
       │                                             │
       │  POST /fetch                                │ Redis
       │  Authorization: Bearer <token>               │
       ▼                                             ▼
┌─────────────┐     route by region          ┌─────────────┐
│     API     │ ───────────────────────────►│   Regional  │
│  (proxy     │  forward request to          │   Proxy     │
│   handler)  │  regional node              │  (Vultr)    │
└─────────────┘                               └──────┬──────┘
                                                     │
                                                     │ HTTP request
                                                     ▼
                                              ┌─────────────┐
                                              │  Target URL │
                                              │ (sees      │
                                              │  regional  │
                                              │  IP)       │
                                              └─────────────┘
```

**Routing:** API looks up session from token → gets `region` → forwards to that region’s proxy (e.g. internal URL or service mesh). Each regional node runs a small HTTP proxy that accepts forwarded requests and performs the fetch.

---

## Security Considerations

1. **Token scope:** Token should be bound to session; validate on each `/fetch`.
2. **SSRF:** Restrict `url` to `https://` and optional allowlist; block private IPs and internal hosts.
3. **Rate limiting:** Per-session and per-token limits on `/fetch`.
4. **Size limits:** Max request/response size for proxy to avoid abuse.
5. **Timeout:** Max fetch duration (e.g. 30s) to prevent long-running requests.

---

## Open Questions

1. Should `/fetch` support streaming (e.g. for large responses)?
2. Should tokens be refreshable (e.g. topup extends token validity)?
3. For hybrid: should WireGuard sessions also get a token for status/topup?
4. Billing for proxy: same per-minute model, or per-request?

---

## Acceptance Criteria

### Proxy-Only (Option A)
- [ ] `POST /session/create` with `mode=proxy` (no public_key) returns token
- [ ] 402 flow works for proxy session creation
- [ ] `POST /fetch` with valid token executes request from regional node and returns response
- [ ] Invalid/expired token returns 401
- [ ] Out-of-credit session returns 402 or 403
- [ ] Billing worker evicts proxy sessions when credit reaches zero

### Hybrid (Option B)
- [ ] All Option A criteria
- [ ] `mode=wireguard` continues to require `public_key` and return WireGuard config
- [ ] Existing agent and WireGuard flow unchanged
- [ ] Redis/model supports both session modes
- [ ] `/fetch` rejects or ignores WireGuard-only sessions (or supports both per design)

---

## References

- Existing: `api/src/server.js`, `api/src/x402.js`, `control/src/sessions.js`
- 402: `X402_ENABLED`, `X402_PAY_TO` in `.env`
