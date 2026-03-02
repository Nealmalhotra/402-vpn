import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "host.docker.internal",
]);

const BLOCKED_HEADER_NAMES = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "authorization",
]);

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function parseIpv4Octets(ip) {
  return ip.split(".").map((part) => Number(part));
}

function isPrivateIpv4(ip) {
  const octets = parseIpv4Octets(ip);
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") {
    return true;
  }
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  return false;
}

function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    return isPrivateIpv4(ip);
  }
  if (family === 6) {
    return isPrivateIpv6(ip);
  }
  return true;
}

function normalizeMethod(method) {
  if (!method) return "GET";
  const upper = String(method).toUpperCase();
  if (!ALLOWED_METHODS.has(upper)) {
    throw new Error(`Unsupported HTTP method: ${upper}`);
  }
  return upper;
}

function sanitizeForwardHeaders(inputHeaders = {}) {
  const output = {};

  for (const [key, value] of Object.entries(inputHeaders)) {
    if (!key || value === undefined || value === null) {
      continue;
    }
    const normalizedKey = String(key).toLowerCase();
    if (BLOCKED_HEADER_NAMES.has(normalizedKey)) {
      continue;
    }
    output[normalizedKey] = String(value);
  }

  return output;
}

function bodyToPayload(body, headers) {
  if (body === null || body === undefined) {
    return undefined;
  }

  if (typeof body === "string") {
    return body;
  }

  const contentType = String(headers["content-type"] || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return JSON.stringify(body);
  }

  return String(body);
}

async function enforceSafeTargetUrl(rawUrl, allowInsecureHttpTargets) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  if (url.protocol !== "https:" && !(allowInsecureHttpTargets && url.protocol === "http:")) {
    throw new Error("Only HTTPS targets are allowed");
  }

  if (!url.hostname) {
    throw new Error("Target URL must include hostname");
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Target host is blocked");
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("Private or internal IP targets are blocked");
    }
    return url.toString();
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) {
    throw new Error("Could not resolve target host");
  }

  for (const address of addresses) {
    if (isPrivateAddress(address.address)) {
      throw new Error("Resolved host points to a private/internal address");
    }
  }

  return url.toString();
}

async function readResponseBodyWithLimit(response, maxResponseBytes) {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      throw new Error(`Upstream response exceeded ${maxResponseBytes} bytes`);
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function performSafeFetch(requestInput, config) {
  const headers = sanitizeForwardHeaders(requestInput.headers);
  const method = normalizeMethod(requestInput.method);
  const url = await enforceSafeTargetUrl(requestInput.url, config.allowInsecureHttpTargets);
  const body = bodyToPayload(requestInput.body, headers);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.fetchTimeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      signal: controller.signal,
      redirect: "follow",
    });

    const responseBody = await readResponseBodyWithLimit(response, config.fetchMaxResponseBytes);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Upstream fetch timed out after ${config.fetchTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeRegionalFetch(region, requestInput, config) {
  if (region.proxy_url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.regionalProxyRequestTimeoutMs);

    try {
      const headers = { "content-type": "application/json" };
      if (config.regionalProxySharedSecret) {
        headers["x-regional-proxy-secret"] = config.regionalProxySharedSecret;
      }

      const response = await fetch(region.proxy_url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestInput),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Regional proxy request failed with status ${response.status}`);
      }

      const payload = await response.json();
      return {
        status: Number(payload.status),
        headers: payload.headers ?? {},
        body: typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body ?? ""),
      };
    } catch (error) {
      if (!config.allowLocalProxyFallback) {
        throw error;
      }
      console.warn(`[api] regional proxy failed for ${region.id}, using local fallback:`, error.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  return performSafeFetch(requestInput, config);
}
