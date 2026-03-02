import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import { config } from "./config.js";
import { executeRegionalFetch, performSafeFetch } from "./fetchProxy.js";
import { createSessionToken, extractBearerToken, verifySessionToken } from "./token.js";
import { buildX402Middleware } from "./x402.js";
import { peerEventsChannel, regionIpPoolKey } from "../../control/src/keys.js";
import { createRedisClient, nowUnixSeconds } from "../../control/src/redis.js";
import { DEFAULT_REGIONS, getRegion, listRegions, seedRegions } from "../../control/src/regions.js";
import {
  SESSION_MODE,
  SESSION_STATUS,
  addCreditSeconds,
  buildStatusPayload,
  computeEffectiveCreditSeconds,
  createSession,
  getSession,
} from "../../control/src/sessions.js";

const createSessionSchema = z.object({
  region: z.string().min(1),
  mode: z.enum([SESSION_MODE.PROXY, SESSION_MODE.WIREGUARD]).optional(),
  public_key: z.string().min(30).max(128).optional(),
  minutes: z.coerce.number().int().positive(),
});

const topupSchema = z.object({
  minutes: z.coerce.number().int().positive(),
});

const fetchRequestSchema = z.object({
  url: z.string().url(),
  method: z.string().optional(),
  headers: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  body: z.union([z.string(), z.number(), z.boolean(), z.record(z.any()), z.array(z.any()), z.null()]).optional(),
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

function createFetchRateLimitKey(sessionId, nowUnix) {
  const minuteBucket = Math.floor(nowUnix / 60);
  return `ratelimit:fetch:${sessionId}:${minuteBucket}`;
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

function resolveSessionMode(modeFromRequest) {
  if (modeFromRequest) {
    return modeFromRequest;
  }
  return config.defaultSessionMode === SESSION_MODE.WIREGUARD ? SESSION_MODE.WIREGUARD : SESSION_MODE.PROXY;
}

function buildProxyToken(session, nowUnix) {
  return createSessionToken(
    {
      sid: session.session_id,
      region: session.region,
      mode: session.mode,
      iat: nowUnix,
      exp: nowUnix + config.sessionTokenTtlSeconds,
    },
    config.sessionTokenSecret,
  );
}

function parseFetchRequest(req) {
  if (req.method === "GET") {
    const parsed = fetchRequestSchema.safeParse({
      url: req.query.url,
      method: req.query.method ?? "GET",
    });
    return parsed;
  }

  return fetchRequestSchema.safeParse(req.body);
}

function classifyFetchError(error) {
  const message = String(error?.message || "");
  if (
    message.includes("Invalid URL") ||
    message.includes("Unsupported HTTP method") ||
    message.includes("Only HTTPS")
  ) {
    return 400;
  }
  if (message.includes("blocked") || message.includes("private/internal")) {
    return 403;
  }
  if (message.includes("exceeded")) {
    return 413;
  }
  if (message.includes("timed out")) {
    return 504;
  }
  return 502;
}

async function resolveSessionFromBearerToken(req, redis) {
  const now = nowUnixSeconds();
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    return { error: { status: 401, body: { error: "Missing bearer token" } } };
  }

  const tokenCheck = verifySessionToken(token, config.sessionTokenSecret, now);
  if (!tokenCheck.ok) {
    return { error: { status: 401, body: { error: `Invalid token: ${tokenCheck.reason}` } } };
  }

  const session = await getSession(redis, tokenCheck.payload.session_id);
  if (!session) {
    return { error: { status: 403, body: { error: "Session not found" } } };
  }

  if (session.region !== tokenCheck.payload.region || session.mode !== tokenCheck.payload.mode) {
    return { error: { status: 401, body: { error: "Token/session mismatch" } } };
  }

  return { session, now };
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
        supports_proxy: Boolean(region.proxy_url) || config.allowLocalProxyFallback,
      })),
    });
  });

  app.post("/session/create", async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    }

    const mode = resolveSessionMode(parsed.data.mode);
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

    if (mode === SESSION_MODE.PROXY && !region.proxy_url && !config.allowLocalProxyFallback) {
      return res.status(503).json({ error: `Region ${region.id} is not configured for proxy mode` });
    }

    if (mode === SESSION_MODE.WIREGUARD && !publicKey) {
      return res.status(400).json({ error: "public_key is required for wireguard sessions" });
    }

    const sessionId = uuidv4();
    const creditSeconds = minutes * 60;

    if (mode === SESSION_MODE.PROXY) {
      const session = {
        session_id: sessionId,
        mode,
        public_key: "",
        assigned_ip: "",
        region: region.id,
        credit_seconds: creditSeconds,
        last_billed_at: now,
        status: SESSION_STATUS.ACTIVE,
        created_at: now,
      };

      await createSession(redis, session, { trackRegionalPeer: false });
      const token = buildProxyToken(session, now);

      return res.status(201).json({
        token,
        session_id: sessionId,
        region: region.id,
        mode,
        credit_seconds: creditSeconds,
        expires_at: now + creditSeconds,
      });
    }

    const ipPoolKey = regionIpPoolKey(region.id);
    const assignedIp = await redis.spop(ipPoolKey);
    if (!assignedIp) {
      return res.status(503).json({ error: `No available IP addresses in region ${region.id}` });
    }

    if (!region.endpoint || !region.public_key) {
      await redis.sadd(ipPoolKey, assignedIp);
      return res.status(503).json({ error: `Region ${region.id} is not configured for wireguard mode` });
    }

    const session = {
      session_id: sessionId,
      mode,
      public_key: publicKey,
      assigned_ip: assignedIp,
      region: region.id,
      credit_seconds: creditSeconds,
      last_billed_at: now,
      status: SESSION_STATUS.ACTIVE,
      created_at: now,
    };

    try {
      await createSession(redis, session, { trackRegionalPeer: true });
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
      mode,
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
      mode: session.mode,
      credit_seconds: newCredit,
      new_expires_at: now + Math.max(newCredit, 0),
      token:
        session.mode === SESSION_MODE.PROXY
          ? buildProxyToken({ session_id: sessionId, mode: session.mode, region: session.region }, now)
          : undefined,
    });
  });

  app.get("/session/me", async (req, res) => {
    const result = await resolveSessionFromBearerToken(req, redis);
    if (result.error) {
      return res.status(result.error.status).json(result.error.body);
    }

    res.json(buildStatusPayload(result.session, result.now));
  });

  app.get("/session/:id/status", async (req, res) => {
    const session = await getSession(redis, req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const payload = buildStatusPayload(session, nowUnixSeconds());
    res.json(payload);
  });

  app.all("/fetch", async (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed. Use GET or POST." });
    }

    const parsed = parseFetchRequest(req);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid fetch request", details: parsed.error.issues });
    }

    const auth = await resolveSessionFromBearerToken(req, redis);
    if (auth.error) {
      return res.status(auth.error.status).json(auth.error.body);
    }

    const session = auth.session;
    if (session.mode !== SESSION_MODE.PROXY) {
      return res.status(403).json({ error: "Fetch is only supported for proxy-mode sessions" });
    }
    if (session.status !== SESSION_STATUS.ACTIVE) {
      return res.status(403).json({ error: `Session is not active (${session.status})` });
    }

    const effectiveCredit = computeEffectiveCreditSeconds(session, auth.now);
    if (effectiveCredit <= 0) {
      return res.status(402).json({ error: "Session out of credit. Top up to continue." });
    }

    const rateLimitKey = createFetchRateLimitKey(session.session_id, auth.now);
    const requestCount = await redis.incr(rateLimitKey);
    if (requestCount === 1) {
      await redis.expire(rateLimitKey, 60);
    }
    if (requestCount > config.fetchRateLimitPerSessionPerMinute) {
      return res.status(429).json({ error: "Fetch rate limit exceeded for this session" });
    }

    const region = await getRegion(redis, session.region);
    if (!region) {
      return res.status(404).json({ error: `Unknown region for session: ${session.region}` });
    }

    try {
      const upstream = await executeRegionalFetch(region, parsed.data, config);
      return res.json({
        status: upstream.status,
        headers: upstream.headers,
        body: upstream.body,
        fetched_from: session.region,
      });
    } catch (error) {
      const status = classifyFetchError(error);
      return res.status(status).json({ error: `Proxy fetch failed: ${error.message}` });
    }
  });

  app.post("/regional/fetch", async (req, res) => {
    if (config.regionalProxySharedSecret) {
      const received = req.headers["x-regional-proxy-secret"];
      if (received !== config.regionalProxySharedSecret) {
        return res.status(401).json({ error: "Invalid regional proxy secret" });
      }
    }

    const parsed = fetchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid regional fetch request", details: parsed.error.issues });
    }

    try {
      const upstream = await performSafeFetch(parsed.data, config);
      return res.json(upstream);
    } catch (error) {
      const status = classifyFetchError(error);
      return res.status(status).json({ error: `Regional fetch failed: ${error.message}` });
    }
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
