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

function stringFromEnv(name, defaultValue = "") {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }
  return value;
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
  defaultSessionMode: process.env.DEFAULT_SESSION_MODE ?? "proxy",
  minimumCreateMinutes: intFromEnv("MIN_CREATE_MINUTES", 10),
  createRateLimitPerIpPerHour: intFromEnv("CREATE_RATE_LIMIT_PER_IP_PER_HOUR", 10),
  autoSeedRegions: boolFromEnv("AUTO_SEED_REGIONS", true),
  sessionTokenSecret: stringFromEnv("SESSION_TOKEN_SECRET", "dev-insecure-session-token-secret"),
  sessionTokenTtlSeconds: intFromEnv("SESSION_TOKEN_TTL_SECONDS", 60 * 60 * 24),
  fetchTimeoutMs: intFromEnv("FETCH_TIMEOUT_MS", 30_000),
  fetchMaxResponseBytes: intFromEnv("FETCH_MAX_RESPONSE_BYTES", 500_000),
  fetchRateLimitPerSessionPerMinute: intFromEnv("FETCH_RATE_LIMIT_PER_SESSION_PER_MINUTE", 60),
  allowInsecureHttpTargets: boolFromEnv("ALLOW_INSECURE_HTTP_TARGETS", false),
  allowLocalProxyFallback: boolFromEnv("ALLOW_LOCAL_PROXY_FALLBACK", true),
  regionalProxySharedSecret: stringFromEnv("REGIONAL_PROXY_SHARED_SECRET", ""),
  regionalProxyRequestTimeoutMs: intFromEnv("REGIONAL_PROXY_REQUEST_TIMEOUT_MS", 10_000),
  x402Enabled: process.env.X402_ENABLED !== "false",
  x402FacilitatorUrl: process.env.X402_FACILITATOR_URL ?? "https://facilitator.x402.org",
  x402Network: process.env.X402_NETWORK ?? "eip155:8453",
  x402PayTo: process.env.X402_PAY_TO ?? "",
};
