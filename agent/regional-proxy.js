import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";

const PORT = Number(process.env.REGIONAL_PROXY_PORT ?? 3000);
const SHARED_SECRET = process.env.REGIONAL_PROXY_SHARED_SECRET ?? "";
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 30_000);
const MAX_RESPONSE_BYTES = Number(process.env.FETCH_MAX_RESPONSE_BYTES ?? 500_000);
const ALLOW_INSECURE_HTTP = (process.env.ALLOW_INSECURE_HTTP_TARGETS ?? "false") === "true";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "host.docker.internal",
]);

const BLOCKED_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers", "transfer-encoding",
  "upgrade", "content-length", "authorization",
]);

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    const n = ip.toLowerCase();
    if (n === "::1" || n === "::") return true;
    if (/^fe[89ab]/.test(n) || /^f[cd]/.test(n)) return true;
    return false;
  }
  return true;
}

async function enforceSafeUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && !(ALLOW_INSECURE_HTTP && url.protocol === "http:")) {
    throw new Error("Only HTTPS targets are allowed");
  }
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Target host is blocked");
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("Private IP targets are blocked");
    return url.toString();
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  for (const addr of addresses) {
    if (isPrivateIp(addr.address)) throw new Error("Resolved host points to a private address");
  }
  return url.toString();
}

function sanitizeHeaders(input = {}) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (k && v != null && !BLOCKED_HEADERS.has(k.toLowerCase())) {
      out[k.toLowerCase()] = String(v);
    }
  }
  return out;
}

async function proxyFetch(reqBody) {
  const { url: rawUrl, method: rawMethod, headers: rawHeaders, body: rawBody } = reqBody;
  if (!rawUrl) throw new Error("Missing url");
  const method = rawMethod ? String(rawMethod).toUpperCase() : "GET";
  if (!ALLOWED_METHODS.has(method)) throw new Error(`Unsupported method: ${method}`);

  const url = await enforceSafeUrl(rawUrl);
  const headers = sanitizeHeaders(rawHeaders);
  let body;
  if (rawBody != null && method !== "GET" && method !== "HEAD") {
    const ct = (headers["content-type"] || "").toLowerCase();
    body = (typeof rawBody === "string") ? rawBody
      : ct.includes("application/json") ? JSON.stringify(rawBody) : String(rawBody);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method, headers, body, signal: controller.signal, redirect: "follow" });
    const reader = resp.body?.getReader();
    const chunks = [];
    let total = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) throw new Error(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`);
          chunks.push(Buffer.from(value));
        }
      }
    }
    return {
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      body: Buffer.concat(chunks).toString("utf8"),
    };
  } finally {
    clearTimeout(timer);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");

  if (req.method === "GET" && req.url === "/health") {
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && req.url === "/regional/fetch") {
    if (SHARED_SECRET && req.headers["x-regional-proxy-secret"] !== SHARED_SECRET) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Invalid regional proxy secret" }));
      return;
    }
    try {
      const body = await readBody(req);
      const result = await proxyFetch(body);
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err.message || "proxy error";
      const code = msg.includes("blocked") || msg.includes("private") ? 403
        : msg.includes("timed out") || msg.includes("abort") ? 504
        : msg.includes("exceeded") ? 413 : 502;
      res.writeHead(code);
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`[regional-proxy] listening on :${PORT}`);
});
