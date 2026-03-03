/**
 * Test script for x402 payment flow against the VPN API.
 *
 * Usage:
 *   EVM_PRIVATE_KEY=0x... API_URL=http://your-control-plane:3000 node scripts/test-x402-payment.js
 *
 * Requirements:
 *   - The wallet behind EVM_PRIVATE_KEY must have Base Sepolia testnet USDC
 *   - Get free testnet USDC at https://faucet.circle.com/ (select Base Sepolia)
 *   - Get free testnet ETH (for gas) at https://portal.cdp.coinbase.com/products/faucet
 */

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";

const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
const API_URL = process.env.API_URL || "http://localhost:3000";

if (!PRIVATE_KEY) {
  console.error("Set EVM_PRIVATE_KEY env var (0x... format)");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);
console.log(`Wallet: ${account.address}`);
console.log(`API:    ${API_URL}`);
console.log("");

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const usdcBalance = await publicClient.readContract({
  address: USDC_ADDRESS,
  abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
  functionName: "balanceOf",
  args: [account.address],
});
console.log(`USDC balance (Base Sepolia): ${formatUnits(usdcBalance, 6)} USDC`);

const ethBalance = await publicClient.getBalance({ address: account.address });
console.log(`ETH balance (Base Sepolia):  ${formatUnits(ethBalance, 18)} ETH`);
console.log("");

if (usdcBalance === 0n) {
  console.error("No USDC! Get testnet USDC at https://faucet.circle.com/ (Base Sepolia)");
  process.exit(1);
}

const client = new x402Client().register("eip155:*", new ExactEvmScheme(account));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

console.log("=== Step 1: Creating a paid proxy session (10 min) ===");
console.log("  This will sign a USDC payment and send it with the request...");
console.log("");

const createResponse = await fetchWithPayment(`${API_URL}/session/create`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ region: "us-west", minutes: 10, mode: "proxy" }),
});

console.log(`  HTTP ${createResponse.status}`);
const session = await createResponse.json();
console.log("  Response:", JSON.stringify(session, null, 2));
console.log("");

if (!session.token) {
  console.error("No token received — payment may have failed");
  process.exit(1);
}

console.log("=== Step 2: Using the session to proxy a request ===");
const fetchResult = await fetch(`${API_URL}/fetch`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.token}`,
  },
  body: JSON.stringify({ url: "https://httpbin.org/ip", method: "GET" }),
});

const proxyResult = await fetchResult.json();
const origin = JSON.parse(proxyResult.body).origin;
console.log(`  Proxied through: ${origin}`);
console.log(`  Region: ${proxyResult.fetched_from}`);
console.log("");

console.log("=== Step 3: Topping up the session (paid) ===");
const topupResponse = await fetchWithPayment(`${API_URL}/session/${session.session_id}/topup`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ minutes: 5 }),
});

console.log(`  HTTP ${topupResponse.status}`);
const topup = await topupResponse.json();
console.log(`  New credit: ${topup.credit_seconds}s`);
console.log("");

console.log("=== Done! Payment flow complete. ===");
