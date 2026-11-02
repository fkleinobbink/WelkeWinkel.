// HTTP-client met nette defaults: browser-UA, retries, timeout, rate limit per host, gzip.
import zlib from "node:zlib";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const hostState = new Map(); // host -> { next: timestamp }

export function setHostDelay(host, ms) {
  const s = hostState.get(host) || { next: 0, delay: 0 };
  s.delay = ms;
  hostState.set(host, s);
}

async function waitForHost(host) {
  const s = hostState.get(host) || { next: 0, delay: 250 };
  hostState.set(host, s);
  const now = Date.now();
  const at = Math.max(now, s.next);
  s.next = at + (s.delay ?? 250);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} ${url}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

// engine: "fetch" (standaard) of "impersonate" (via tools/impersonate_server.py, browser-TLS)
let ENGINE = { type: "fetch" };
export function setEngine(type, impersonate = "chrome", port = 8765) {
  ENGINE = { type, impersonate, port };
}

async function doFetch(url, { method, body, timeout, headers, maxBytes }) {
  if (ENGINE.type === "impersonate") {
    const r = await fetch(`http://127.0.0.1:${ENGINE.port}/fetch`, {
      method: "POST",
      signal: AbortSignal.timeout(timeout + 5000),
      body: JSON.stringify({ url, method, body: body ?? null, timeout: timeout / 1000, impersonate: ENGINE.impersonate, headers: { "accept-language": "nl-NL,nl;q=0.9", ...headers } }),
    });
    const buffer = Buffer.from(await r.arrayBuffer());
    if (r.status === 599) throw new Error("impersonate: " + buffer.toString().slice(0, 200));
    const status = parseInt(r.headers.get("x-status"), 10);
    return { status, ok: status >= 200 && status < 300, url: r.headers.get("x-final-url") || url, headers: new Headers({ "content-type": r.headers.get("x-content-type") || "" }), buffer };
  }
  const res = await fetch(url, {
    method,
    body,
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
    headers: {
      "user-agent": UA,
      "accept-language": "nl-NL,nl;q=0.9,en;q=0.8",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
      ...headers,
    },
  });
  const chunks = [];
  let size = 0;
  if (res.body) {
    for await (const c of res.body) {
      size += c.length;
      if (size > maxBytes) { try { await res.body.cancel(); } catch {} break; }
      chunks.push(c);
    }
  }
  return { status: res.status, ok: res.ok, url: res.url, headers: res.headers, buffer: Buffer.concat(chunks) };
}

export async function get(url, opts = {}) {
  const { headers = {}, retries = 2, timeout = 30000, method = "GET", body, raw = false, okStatuses, maxBytes = 80e6 } = opts;
  const host = new URL(url).host;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitForHost(host);
    try {
      const res = await doFetch(url, { method, body, timeout, headers, maxBytes });
      let buf = res.buffer;
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        try { buf = zlib.gunzipSync(buf); } catch {}
      }
      const ok = okStatuses ? okStatuses.includes(res.status) : res.ok;
      if (!ok) {
        if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
          const ra = parseInt(res.headers.get("retry-after") || "", 10);
          await new Promise((r) => setTimeout(r, (Number.isFinite(ra) ? ra * 1000 : 3000 * (attempt + 1))));
          continue;
        }
        throw new HttpError(res.status, url, buf.toString("utf8").slice(0, 2000));
      }
      if (raw) return { status: res.status, url: res.url, headers: res.headers, buffer: buf };
      return { status: res.status, url: res.url, headers: res.headers, text: buf.toString("utf8") };
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError) throw e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function getJson(url, opts = {}) {
  const r = await get(url, { ...opts, headers: { accept: "application/json", ...(opts.headers || {}) } });
  return JSON.parse(r.text);
}

// Herkent typische bot-blokkades
export function blockSignal(text = "", status = 200) {
  const t = text.slice(0, 20000).toLowerCase();
  if (status === 403 || status === 429) return `status ${status}`;
  if (t.includes("cf-chl") || t.includes("challenge-platform")) return "cloudflare";
  if (t.includes("_incapsula_") || t.includes("incapsula")) return "incapsula";
  if (t.includes("akamai") && t.includes("access denied")) return "akamai";
  if (t.includes("datadome")) return "datadome";
  if (t.includes("perimeterx") || t.includes("px-captcha")) return "perimeterx";
  if (t.includes("captcha") && t.length < 15000) return "captcha";
  return null;
}
