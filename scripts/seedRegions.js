import dotenv from "dotenv";

import { createRedisClient } from "../control/src/redis.js";
import { DEFAULT_REGIONS, seedRegions } from "../control/src/regions.js";

dotenv.config();

function parseRegionSeedData() {
  if (!process.env.REGION_SEED_JSON) {
    return DEFAULT_REGIONS;
  }

  const parsed = JSON.parse(process.env.REGION_SEED_JSON);
  if (!Array.isArray(parsed)) {
    throw new Error("REGION_SEED_JSON must be an array");
  }
  return parsed;
}

async function main() {
  const redis = createRedisClient(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const regions = parseRegionSeedData();

  await seedRegions(redis, regions);
  await redis.quit();
  console.log(`Seeded ${regions.length} region(s)`);
}

main().catch((error) => {
  console.error("Region seeding failed:", error);
  process.exit(1);
});
