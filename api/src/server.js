import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import { config } from "./config.js";
import { buildX402Middleware } from "./x402.js";
import { peerEventsChannel, regionIpPoolKey } from "../../control/src/keys.js";
import { createRedisClient, nowUnixSeconds } from "../../control/src/redis.js";
import { DEFAULT_REGIONS, getRegion, listRegions, seedRegions } from "../../control/src/regions.js";
import {
  SESSION_STATUS,
  addCreditSeconds,
  buildStatusPayload,
  createSession,
  getSession,
} from "../../control/src/sessions.js";

const createSessionSchema = z.object({
  region: z.string().min(1),
  public_key: z.string().min(30).max(128),
  minutes: z.coerce.number().int().positive(),
});

const topupSchema = z.object({
  minutes: z.coerce.number().int().positive(),
});

function getSourceIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function createRateLimitKey(sourceIp, nowUnix) {
  const hourBucket = Math.floor(nowUnix / 3600);
  return `ratelimit:create:${sourceIp}:${hourBucket}`;
}

function createPeerAddEvent(session, timestamp) {
  return {
    type: "PEER_ADD",
    session_id: session.session_id,
    region: session.region,
    public_key: session.public_key,
    assigned_ip: session.assigned_ip,
    occurred_at: timestamp,
  };
}

async function start() {
  const redis = createRedisClient(config.redisUrl);
  if (config.autoSeedRegions) {
    await seedRegions(redis, DEFAULT_REGIONS);
  }

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "32kb" }));
  app.use(buildX402Middleware(redis, config));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/regions", async (_req, res) => {
    const regions = await listRegions(redis);
    res.json({
      regions: regions.map((region) => ({
        id: region.id,
        city: region.city,
        price_per_minute_usd: region.price_per_minute_usd,
      })),
    });
  });

  app.post("/session/create", async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    }

    const { region: regionId, public_key: publicKey, minutes } = parsed.data;
    if (minutes < config.minimumCreateMinutes) {
      return res.status(400).json({
        error: `Minimum purchase is ${config.minimumCreateMinutes} minutes`,
      });
    }

    const now = nowUnixSeconds();
    const sourceIp = getSourceIp(req);
    const rateLimitKey = createRateLimitKey(sourceIp, now);
    const requestCount = await redis.incr(rateLimitKey);
    if (requestCount === 1) {
      await redis.expire(rateLimitKey, 3600);
    }

    if (requestCount > config.createRateLimitPerIpPerHour) {
      return res.status(429).json({ error: "Rate limit exceeded for /session/create" });
    }

    const region = await getRegion(redis, regionId);
    if (!region) {
      return res.status(404).json({ error: `Unknown region: ${regionId}` });
    }

    const ipPoolKey = regionIpPoolKey(region.id);
    const assignedIp = await redis.spop(ipPoolKey);
    if (!assignedIp) {
      return res.status(503).json({ error: `No available IP addresses in region ${region.id}` });
    }

    const sessionId = uuidv4();
    const creditSeconds = minutes * 60;
    const session = {
      session_id: sessionId,
      public_key: publicKey,
      assigned_ip: assignedIp,
      region: region.id,
      credit_seconds: creditSeconds,
      last_billed_at: now,
      status: SESSION_STATUS.ACTIVE,
      created_at: now,
    };

    try {
      await createSession(redis, session);
      await redis.publish(peerEventsChannel(region.id), JSON.stringify(createPeerAddEvent(session, now)));
    } catch (error) {
      await redis.sadd(ipPoolKey, assignedIp);
      throw error;
    }

    return res.status(201).json({
      session_id: sessionId,
      wireguard_config: {
        server_public_key: region.public_key,
        assigned_ip: `${assignedIp}/32`,
        endpoint: region.endpoint,
        dns: config.defaultDns,
      },
      credit_seconds: creditSeconds,
      expires_at: now + creditSeconds,
    });
  });

  app.post("/session/:id/topup", async (req, res) => {
    const parsed = topupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    }

    const sessionId = req.params.id;
    const session = await getSession(redis, sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (session.status !== SESSION_STATUS.ACTIVE) {
      return res.status(409).json({ error: `Cannot top up session in status ${session.status}` });
    }

    const additionalSeconds = parsed.data.minutes * 60;
    const newCredit = Number(await addCreditSeconds(redis, sessionId, additionalSeconds));
    const now = nowUnixSeconds();

    return res.json({
      session_id: sessionId,
      credit_seconds: newCredit,
      new_expires_at: now + Math.max(newCredit, 0),
    });
  });

  app.get("/session/:id/status", async (req, res) => {
    const session = await getSession(redis, req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const payload = buildStatusPayload(session, nowUnixSeconds());
    res.json(payload);
  });

  app.use((error, _req, res, _next) => {
    console.error("[api] request failed:", error);
    res.status(500).json({ error: "Internal server error" });
  });

  app.listen(config.apiPort, () => {
    console.log(`[api] listening on :${config.apiPort}`);
  });
}

start().catch((error) => {
  console.error("[api] fatal startup error:", error);
  process.exit(1);
});
