import test from "node:test";
import assert from "node:assert/strict";

import { computeBillingUpdate } from "../src/logic.js";

test("computeBillingUpdate skips non-active sessions", () => {
  const update = computeBillingUpdate(
    {
      status: "evicted",
      credit_seconds: 120,
      last_billed_at: 1000,
    },
    1030,
  );

  assert.equal(update.action, "skip");
});

test("computeBillingUpdate debits elapsed credit for active sessions", () => {
  const update = computeBillingUpdate(
    {
      status: "active",
      credit_seconds: 120,
      last_billed_at: 1000,
    },
    1030,
  );

  assert.equal(update.action, "debit");
  assert.equal(update.newCreditSeconds, 90);
});

test("computeBillingUpdate evicts when credit runs out", () => {
  const update = computeBillingUpdate(
    {
      status: "active",
      credit_seconds: 30,
      last_billed_at: 1000,
    },
    1030,
  );

  assert.equal(update.action, "evict");
  assert.equal(update.newCreditSeconds, 0);
  assert.equal(update.newStatus, "evicted");
});
