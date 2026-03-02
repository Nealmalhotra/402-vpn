import Redis from "ioredis";

export function createRedisClient(redisUrl) {
  if (!redisUrl) {
    throw new Error("REDIS_URL is required");
  }

  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export function nowUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}
