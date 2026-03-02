import dotenv from "dotenv";

import { ACTIVE_SESSIONS_KEY, peerEventsChannel, sessionKey } from "../../control/src/keys.js";
import { nowUnixSeconds, createRedisClient } from "../../control/src/redis.js";
import { getSession, markSessionEvicted } from "../../control/src/sessions.js";
import { computeBillingUpdate } from "./logic.js";

dotenv.config();

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const tickSeconds = Number(process.env.BILLING_TICK_SECONDS ?? 30);

if (!Number.isFinite(tickSeconds) || tickSeconds <= 0) {
  throw new Error("BILLING_TICK_SECONDS must be a positive number");
}

function buildEvictionEvent(session, timestamp) {
  return {
    type: "PEER_EVICT",
    session_id: session.session_id,
    region: session.region,
    public_key: session.public_key,
    assigned_ip: session.assigned_ip,
    occurred_at: timestamp,
  };
}

export async function runBillingTick(redis, nowUnix = nowUnixSeconds()) {
  const sessionIds = await redis.smembers(ACTIVE_SESSIONS_KEY);
  const summary = {
    scanned: sessionIds.length,
    debited: 0,
    evicted: 0,
    skipped: 0,
    cleaned_missing: 0,
  };

  for (const sessionId of sessionIds) {
    const session = await getSession(redis, sessionId);
    if (!session) {
      await redis.srem(ACTIVE_SESSIONS_KEY, sessionId);
      summary.cleaned_missing += 1;
      continue;
    }

    const billing = computeBillingUpdate(session, nowUnix);
    if (billing.action === "skip") {
      summary.skipped += 1;
      continue;
    }

    if (billing.action === "debit") {
      await redis.hset(sessionKey(sessionId), {
        credit_seconds: String(billing.newCreditSeconds),
        last_billed_at: String(nowUnix),
      });
      summary.debited += 1;
      continue;
    }

    await markSessionEvicted(redis, session, nowUnix);
    await redis.publish(peerEventsChannel(session.region), JSON.stringify(buildEvictionEvent(session, nowUnix)));
    summary.evicted += 1;
  }

  return summary;
}

async function start() {
  const redis = createRedisClient(redisUrl);

  console.log(`[billing] worker started (tick=${tickSeconds}s)`);

  await runBillingTick(redis);
  const interval = setInterval(async () => {
    try {
      const result = await runBillingTick(redis);
      console.log(
        `[billing] tick scanned=${result.scanned} debited=${result.debited} evicted=${result.evicted} skipped=${result.skipped}`,
      );
    } catch (error) {
      console.error("[billing] tick failed:", error);
    }
  }, tickSeconds * 1000);

  const shutdown = async () => {
    clearInterval(interval);
    await redis.quit();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  console.error("[billing] fatal startup error:", error);
  process.exit(1);
});
