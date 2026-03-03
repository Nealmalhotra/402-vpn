# 402-VPN Agent API

Pay-per-minute HTTP proxy. Pay with USDC on Base Sepolia, get a bearer token, proxy requests through regional exit nodes.

## Setup

```bash
npm install @x402/fetch @x402/evm viem
```

You need a wallet with Base Sepolia testnet USDC and ETH (for gas):
- USDC faucet: https://faucet.circle.com/ (select Base Sepolia)
- ETH faucet: https://portal.cdp.coinbase.com/products/faucet (select Base Sepolia)

## Client Code

```javascript
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const API = process.env.VPN_API_URL; // e.g. http://your-control-plane:3000
const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
const client = new x402Client().register("eip155:*", new ExactEvmScheme(account));
const pay = wrapFetchWithPayment(fetch, client);

// 1. Create session (auto-pays USDC)
const res = await pay(`${API}/session/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ region: "us-west", minutes: 10, mode: "proxy" }),
});
const { token, session_id, credit_seconds } = await res.json();

// 2. Proxy requests (free while session active)
const result = await fetch(`${API}/fetch`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ url: "https://example.com", method: "GET" }),
});
const { status, headers, body } = await result.json();

// 3. Top up when running low (auto-pays USDC)
const topup = await pay(`${API}/session/${session_id}/topup`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ minutes: 5 }),
});
```

## Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /regions` | None | List regions |
| `POST /session/create` | x402 payment | Create session. Body: `{ region, minutes, mode: "proxy" }` |
| `POST /session/:id/topup` | x402 payment | Add minutes. Body: `{ minutes }` |
| `GET /session/me` | `Bearer <token>` | Session status |
| `POST /fetch` | `Bearer <token>` | Proxy a request. Body: `{ url, method, headers?, body? }` |

## Pricing

$0.001/minute. Minimum 10 minutes ($0.01) per session. Paid in USDC on Base Sepolia (testnet).

## Regions

| ID | City | Exit IP |
|---|---|---|
| `us-west` | Seattle | Vultr node |

## Notes

- `/fetch` response returns `{ status, headers, body, fetched_from }` — the body is a string.
- Sessions expire when credit runs out. Check `GET /session/me` for `credit_seconds`.
- Rate limits: 10 session creates/hour per IP, 60 fetches/minute per session.
- Only HTTPS target URLs are allowed. Private/internal IPs are blocked (SSRF protection).
