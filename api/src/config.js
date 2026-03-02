import dotenv from "dotenv";

dotenv.config();

function intFromEnv(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function boolFromEnv(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === "true";
}

export const config = {
  apiPort: intFromEnv("API_PORT", 3000),
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  defaultDns: process.env.DEFAULT_DNS ?? "1.1.1.1",
  minimumCreateMinutes: intFromEnv("MIN_CREATE_MINUTES", 10),
  createRateLimitPerIpPerHour: intFromEnv("CREATE_RATE_LIMIT_PER_IP_PER_HOUR", 10),
  autoSeedRegions: boolFromEnv("AUTO_SEED_REGIONS", true),
  x402Enabled: process.env.X402_ENABLED !== "false",
  x402FacilitatorUrl: process.env.X402_FACILITATOR_URL ?? "https://facilitator.x402.org",
  x402Network: process.env.X402_NETWORK ?? "eip155:8453",
  x402PayTo: process.env.X402_PAY_TO ?? "",
};
