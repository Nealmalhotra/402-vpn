import test from "node:test";
import assert from "node:assert/strict";

import { buildStatusPayload, computeEffectiveCreditSeconds } from "../src/sessions.js";

test("computeEffectiveCreditSeconds accounts for elapsed billing time", () => {
  const effective = computeEffectiveCreditSeconds(
    {
      status: "active",
      credit_seconds: 100,
      last_billed_at: 1000,
    },
    1025,
  );

  assert.equal(effective, 75);
});

test("buildStatusPayload includes low-credit warning under 60 seconds", () => {
  const payload = buildStatusPayload(
    {
      session_id: "abc",
      status: "active",
      credit_seconds: 55,
      last_billed_at: 1000,
      region: "us-west",
    },
    1000,
  );

  assert.equal(payload.low_credit_warning, true);
  assert.equal(payload.credit_seconds, 55);
  assert.equal(payload.mode, "wireguard");
  assert.equal(payload.warning, "Credit below 60 seconds. Top up soon to avoid eviction.");
});
