import { generateIpv4PoolFrom24Cidr } from "./ipPool.js";
import { REGIONS_SET_KEY, regionIpPoolKey, regionKey } from "./keys.js";

export const DEFAULT_REGIONS = [
  {
    id: "us-west",
    city: "San Francisco",
    endpoint: "203.0.113.10:51820",
    public_key: "REPLACE_WITH_REAL_US_WEST_WG_PUBLIC_KEY",
    subnet: "10.8.0.0/24",
    price_per_minute_usd: 0.001,
  },
  {
    id: "eu-central",
    city: "Frankfurt",
    endpoint: "198.51.100.20:51820",
    public_key: "REPLACE_WITH_REAL_EU_CENTRAL_WG_PUBLIC_KEY",
    subnet: "10.9.0.0/24",
    price_per_minute_usd: 0.001,
  },
];

function assertRegionShape(region) {
  if (!region?.id || !region?.endpoint || !region?.public_key || !region?.subnet) {
    throw new Error(`Invalid region definition: ${JSON.stringify(region)}`);
  }
}

function parseRegionHash(id, hash) {
  if (!hash || Object.keys(hash).length === 0) {
    return null;
  }

  return {
    id,
    city: hash.city,
    endpoint: hash.endpoint,
    public_key: hash.public_key,
    subnet: hash.subnet,
    price_per_minute_usd: Number(hash.price_per_minute_usd),
  };
}

export async function seedRegions(redis, regions = DEFAULT_REGIONS) {
  for (const region of regions) {
    assertRegionShape(region);

    await redis.sadd(REGIONS_SET_KEY, region.id);
    await redis.hset(regionKey(region.id), {
      region_id: region.id,
      city: region.city ?? region.id,
      endpoint: region.endpoint,
      public_key: region.public_key,
      subnet: region.subnet,
      price_per_minute_usd: String(region.price_per_minute_usd),
    });

    const poolKey = regionIpPoolKey(region.id);
    const poolCount = await redis.scard(poolKey);
    if (poolCount === 0) {
      const pool = generateIpv4PoolFrom24Cidr(region.subnet);
      if (pool.length > 0) {
        await redis.sadd(poolKey, ...pool);
      }
    }
  }
}

export async function listRegions(redis) {
  const ids = await redis.smembers(REGIONS_SET_KEY);
  if (ids.length === 0) {
    return [];
  }

  const pipeline = redis.pipeline();
  for (const id of ids) {
    pipeline.hgetall(regionKey(id));
  }

  const rows = await pipeline.exec();
  return ids
    .map((id, index) => parseRegionHash(id, rows[index][1]))
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function getRegion(redis, id) {
  const hash = await redis.hgetall(regionKey(id));
  return parseRegionHash(id, hash);
}

export async function getRegionPricePerMinute(redis, id) {
  const region = await getRegion(redis, id);
  if (!region) {
    return null;
  }
  return Number(region.price_per_minute_usd);
}
