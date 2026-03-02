import crypto from "node:crypto";

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signSegment(segment, secret) {
  return crypto.createHmac("sha256", secret).update(segment).digest("base64url");
}

function constantTimeEquals(a, b) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

export function createSessionToken(payload, secret) {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = signSegment(encodedPayload, secret);
  return `v1.${encodedPayload}.${signature}`;
}

export function verifySessionToken(token, secret, nowUnix) {
  if (!token || typeof token !== "string") {
    return { ok: false, reason: "missing_token" };
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    return { ok: false, reason: "invalid_token_format" };
  }

  const [, encodedPayload, signature] = parts;
  const expectedSignature = signSegment(encodedPayload, secret);
  if (!constantTimeEquals(signature, expectedSignature)) {
    return { ok: false, reason: "invalid_token_signature" };
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(encodedPayload));
  } catch {
    return { ok: false, reason: "invalid_token_payload" };
  }

  if (!payload?.sid || !payload?.region || !payload?.mode || !payload?.exp) {
    return { ok: false, reason: "invalid_token_claims" };
  }

  if (Number(payload.exp) <= nowUnix) {
    return { ok: false, reason: "token_expired" };
  }

  return {
    ok: true,
    payload: {
      session_id: String(payload.sid),
      region: String(payload.region),
      mode: String(payload.mode),
      expires_at: Number(payload.exp),
      issued_at: Number(payload.iat ?? 0),
    },
  };
}

export function extractBearerToken(authorizationHeader) {
  if (!authorizationHeader || typeof authorizationHeader !== "string") {
    return null;
  }

  const [scheme, token] = authorizationHeader.trim().split(/\s+/);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token;
}
