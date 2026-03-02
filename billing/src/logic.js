import { SESSION_STATUS } from "../../control/src/sessions.js";

export function computeBillingUpdate(session, nowUnix) {
  if (!session || session.status !== SESSION_STATUS.ACTIVE) {
    return { action: "skip", reason: "session_not_active" };
  }

  const elapsed = Math.max(0, nowUnix - session.last_billed_at);
  if (elapsed === 0) {
    return { action: "skip", reason: "no_elapsed_time" };
  }

  const remaining = session.credit_seconds - elapsed;

  if (remaining <= 0) {
    return {
      action: "evict",
      elapsed,
      newCreditSeconds: 0,
      newStatus: SESSION_STATUS.EVICTED,
    };
  }

  return {
    action: "debit",
    elapsed,
    newCreditSeconds: remaining,
    newStatus: SESSION_STATUS.ACTIVE,
  };
}
