import test from "node:test";
import assert from "node:assert/strict";

import { createSessionToken, extractBearerToken, verifySessionToken } from "../src/token.js";

test("createSessionToken + verifySessionToken round trip", () => {
  const now = 1_700_000_000;
  const token = createSessionToken(
    {
      sid: "session-123",
      region: "us-west",
      mode: "proxy",
      iat: now,
      exp: now + 60,
    },
    "secret",
  );

  const verified = verifySessionToken(token, "secret", now);
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.session_id, "session-123");
  assert.equal(verified.payload.region, "us-west");
  assert.equal(verified.payload.mode, "proxy");
});

test("verifySessionToken rejects expired token", () => {
  const token = createSessionToken(
    {
      sid: "session-123",
      region: "us-west",
      mode: "proxy",
      iat: 1000,
      exp: 1010,
    },
    "secret",
  );

  const verified = verifySessionToken(token, "secret", 1020);
  assert.equal(verified.ok, false);
  assert.equal(verified.reason, "token_expired");
});

test("extractBearerToken parses bearer authorization header", () => {
  assert.equal(extractBearerToken("Bearer abc.123"), "abc.123");
  assert.equal(extractBearerToken("Basic xyz"), null);
  assert.equal(extractBearerToken(undefined), null);
});
