import { ACTIVE_SESSIONS_KEY, regionActivePeersKey, sessionKey } from "./keys.js";

export const SESSION_STATUS = {
  ACTIVE: "active",
  EVICTED: "evicted",
  EXPIRED: "expired",
};

export const SESSION_MODE = {
  PROXY: "proxy",
  WIREGUARD: "wireguard",
};

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function parseSessionHash(sessionId, hash) {
  if (!hash || Object.keys(hash).length === 0) {
    return null;
  }

  return {
    session_id: sessionId,
    mode: hash.mode || SESSION_MODE.WIREGUARD,
    public_key: hash.public_key,
    assigned_ip: hash.assigned_ip,
    region: hash.region,
    credit_seconds: toInt(hash.credit_seconds),
    last_billed_at: toInt(hash.last_billed_at),
    status: hash.status,
    created_at: toInt(hash.created_at),
    evicted_at: hash.evicted_at ? toInt(hash.evicted_at) : null,
  };
}

export async function getSession(redis, sessionId) {
  const hash = await redis.hgetall(sessionKey(sessionId));
  return parseSessionHash(sessionId, hash);
}

export async function createSession(redis, session, options = {}) {
  const mode = session.mode || SESSION_MODE.WIREGUARD;
  const shouldTrackRegionalPeer = options.trackRegionalPeer === true && mode === SESSION_MODE.WIREGUARD;

  const tx = redis.multi().hset(sessionKey(session.session_id), {
    session_id: session.session_id,
    mode,
    public_key: session.public_key ?? "",
    assigned_ip: session.assigned_ip ?? "",
    region: session.region,
    credit_seconds: String(session.credit_seconds),
    last_billed_at: String(session.last_billed_at),
    status: session.status,
    created_at: String(session.created_at),
  });

  tx.sadd(ACTIVE_SESSIONS_KEY, session.session_id);
  if (shouldTrackRegionalPeer) {
    tx.sadd(regionActivePeersKey(session.region), session.session_id);
  }

  await tx.exec();

  return session;
}

export async function addCreditSeconds(redis, sessionId, deltaSeconds) {
  return redis.hincrby(sessionKey(sessionId), "credit_seconds", deltaSeconds);
}

export async function markSessionEvicted(redis, session, nowUnix) {
  await redis
    .multi()
    .hset(sessionKey(session.session_id), {
      status: SESSION_STATUS.EVICTED,
      credit_seconds: "0",
      last_billed_at: String(nowUnix),
      evicted_at: String(nowUnix),
    })
    .srem(ACTIVE_SESSIONS_KEY, session.session_id)
    .expire(sessionKey(session.session_id), 60 * 60 * 24)
    .exec();
}

export function computeEffectiveCreditSeconds(session, nowUnix) {
  if (!session || session.status !== SESSION_STATUS.ACTIVE) {
    return Math.max(session?.credit_seconds ?? 0, 0);
  }

  const elapsed = Math.max(0, nowUnix - session.last_billed_at);
  return Math.max(0, session.credit_seconds - elapsed);
}

export function buildStatusPayload(session, nowUnix) {
  const effectiveCredit = computeEffectiveCreditSeconds(session, nowUnix);
  const lowCredit = session.status === SESSION_STATUS.ACTIVE && effectiveCredit < 60;
  return {
    session_id: session.session_id,
    mode: session.mode || SESSION_MODE.WIREGUARD,
    status: session.status,
    credit_seconds: effectiveCredit,
    region: session.region,
    low_credit_warning: lowCredit,
    warning: lowCredit ? "Credit below 60 seconds. Top up soon to avoid eviction." : null,
  };
}
