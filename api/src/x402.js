import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";

import { getRegionPricePerMinute } from "../../control/src/regions.js";
import { getSession } from "../../control/src/sessions.js";

const DEFAULT_PRICE_PER_MINUTE_USD = 0.001;

function parseRequestedMinutes(value, fallbackMinutes = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMinutes;
  }
  return Math.ceil(parsed);
}

function toUsdString(amount) {
  return `$${amount.toFixed(6)}`;
}

function extractTopupSessionId(pathname) {
  const match = pathname.match(/^\/session\/([^/]+)\/topup$/);
  return match?.[1] ?? null;
}

async function resolveRegionPrice(redis, regionId) {
  if (!regionId) {
    return DEFAULT_PRICE_PER_MINUTE_USD;
  }
  return (await getRegionPricePerMinute(redis, regionId)) ?? DEFAULT_PRICE_PER_MINUTE_USD;
}

export function buildX402Middleware(redis, config) {
  if (!config.x402Enabled) {
    return (_req, _res, next) => next();
  }

  if (!config.x402PayTo) {
    throw new Error("X402_PAY_TO is required when x402 is enabled");
  }

  const facilitator = new HTTPFacilitatorClient({ url: config.x402FacilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(config.x402Network, new ExactEvmScheme());

  return paymentMiddleware(
    {
      "POST /session/create": {
        accepts: {
          scheme: "exact",
          network: config.x402Network,
          payTo: config.x402PayTo,
          maxTimeoutSeconds: 300,
          price: async (context) => {
            const body = context.adapter.getBody?.() ?? {};
            const minutes = parseRequestedMinutes(body.minutes, config.minimumCreateMinutes);
            const regionId = typeof body.region === "string" ? body.region : "";
            const perMinute = await resolveRegionPrice(redis, regionId);
            const billedMinutes = Math.max(minutes, config.minimumCreateMinutes);
            return toUsdString(billedMinutes * perMinute);
          },
        },
        description: "Create a paid VPN session",
      },
      "POST /session/[id]/topup": {
        accepts: {
          scheme: "exact",
          network: config.x402Network,
          payTo: config.x402PayTo,
          maxTimeoutSeconds: 300,
          price: async (context) => {
            const body = context.adapter.getBody?.() ?? {};
            const minutes = parseRequestedMinutes(body.minutes, 1);
            const sessionId = extractTopupSessionId(context.path);
            if (!sessionId) {
              return toUsdString(minutes * DEFAULT_PRICE_PER_MINUTE_USD);
            }

            const session = await getSession(redis, sessionId);
            const perMinute = await resolveRegionPrice(redis, session?.region);
            return toUsdString(minutes * perMinute);
          },
        },
        description: "Top up a paid VPN session",
      },
    },
    resourceServer,
  );
}
