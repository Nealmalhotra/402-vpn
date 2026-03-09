# Launch Posts

Your live URL: **https://144-202-82-48.sslip.io**

---

## 1. Hacker News (Show HN)

**Title:** Show HN: 402-VPN – Pay-per-minute HTTP proxy for AI agents, paid with USDC via x402

**Text:**
I built a pay-per-minute HTTP proxy that AI agents can use autonomously. No accounts, no API keys – just pay with USDC on Base using the x402 protocol and get a bearer token.

How it works:
1. POST /session/create (x402 auto-charges your wallet $0.001/min in USDC)
2. Get a bearer token
3. POST /fetch with the token to proxy requests through regional exit nodes
4. Top up anytime

The x402 protocol (HTTP 402 Payment Required) lets any HTTP client pay for resources by including a signed payment in the request header. This means AI agents with a wallet can buy proxy sessions without human intervention.

Tech: Node.js API + Go regional agents, Redis for state, Upstash for hosted Redis, regional proxy nodes on Vultr.

Live: https://144-202-82-48.sslip.io
Docs: https://144-202-82-48.sslip.io/docs/agent-quickstart
Code: https://github.com/Nealmalhotra/402-vpn

Currently on Base Sepolia testnet. One region (Seattle). Looking for feedback.

**Post to:** https://news.ycombinator.com/submit

---

## 2. X/Twitter

**Post:**
Built a pay-per-minute HTTP proxy for AI agents 🔌

No accounts. No API keys. Just USDC + x402.

→ Agent calls POST /session/create
→ x402 auto-charges the wallet
→ Agent gets a bearer token
→ Proxy requests through regional exit nodes

$0.001/min. Live on testnet.

https://144-202-82-48.sslip.io

Built with @x402protocol on @base

---

## 3. Reddit

### r/cryptocurrency

**Title:** I built a VPN proxy service where you pay per minute with USDC – no accounts needed

**Text:**
I built 402-VPN, a pay-per-minute HTTP proxy that uses the x402 protocol for payments. The idea is simple: instead of monthly subscriptions, you pay exactly for what you use in USDC.

The x402 protocol uses the HTTP 402 "Payment Required" status code. When you hit a protected endpoint, the server tells you the price, your client signs a USDC payment, and you get access. No accounts, no email, no credit cards.

It's designed for AI agents that need to make HTTP requests from different IPs, but anyone can use it.

Currently on Base Sepolia testnet, one region (Seattle). $0.001/minute.

https://144-202-82-48.sslip.io

### r/selfhosted

**Title:** Pay-per-minute HTTP proxy with crypto payments – open source, self-hostable

**Text:**
I open-sourced a pay-per-minute VPN/proxy service. It uses the x402 protocol for USDC payments on Base.

Architecture:
- Control plane: Node.js API + billing worker (runs anywhere)
- Regional nodes: Lightweight proxy (single file, zero npm deps) + Go agent for WireGuard
- Redis: Upstash (or self-hosted)

You can self-host the whole thing. The control plane is one `npm ci` + `node api/src/server.js`. Regional nodes are literally one 5KB JS file.

Live demo: https://144-202-82-48.sslip.io
Code: https://github.com/Nealmalhotra/402-vpn

### r/artificial

**Title:** Built an HTTP proxy service that AI agents can pay for autonomously with USDC

**Text:**
One of the problems with AI agents making HTTP requests is that they often need to rotate IPs or access geo-restricted content. Existing proxy services require accounts, API keys, and credit cards – things agents can't set up on their own.

I built 402-VPN to solve this. It uses the x402 payment protocol, which means any agent with a crypto wallet can:

1. Discover the price (HTTP 402 response)
2. Sign a USDC payment
3. Get a session token
4. Proxy requests through regional exit nodes

No human in the loop. The @x402/fetch npm package handles the payment flow automatically.

Demo: https://144-202-82-48.sslip.io
Agent docs: https://144-202-82-48.sslip.io/docs/agent-quickstart

---

## 4. x402 Community

**Post in x402 Discord/GitHub Discussions:**

Built a real-world x402-gated service: pay-per-minute HTTP proxy for AI agents.

Uses @x402/express middleware to gate POST /session/create and POST /session/:id/topup. Dynamic pricing based on region and minutes requested.

The x402 flow works great for this use case – agents can autonomously discover the price, pay, and start proxying. No accounts needed.

Live: https://144-202-82-48.sslip.io
Code: https://github.com/Nealmalhotra/402-vpn

Would love feedback on the integration pattern.

---

## 5. Product Hunt (when ready for a bigger launch)

**Tagline:** Pay-per-minute HTTP proxy for AI agents. Pay with USDC, no accounts needed.

**Description:**
402-VPN lets AI agents (and humans) buy time-limited HTTP proxy sessions with USDC. No accounts, no API keys – just cryptocurrency payments via the x402 protocol.

Agents call one endpoint, auto-pay from their wallet, and get a bearer token to proxy requests through regional exit nodes. Perfect for web scraping, geo-testing, or any task where an agent needs a different IP.

Save this for when you have a domain, more regions, and are on mainnet.
