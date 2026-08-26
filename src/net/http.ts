// src/net/http.ts
import * as https from "node:https";
import * as http from "node:http";
import { setServers } from "node:dns";

const DNS_RESOLVERS = ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9"];
setServers(DNS_RESOLVERS);

const UA_POOL: ReadonlyArray<string> = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function randomUA(): string {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

// SSRF Guard: Block internal/local IPs
function isPrivateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return true;
    if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
    if (host.startsWith("172.")) {
      const parts = host.split(".");
      const second = parseInt(parts[1], 10);
      if (second >= 16 && second <= 31) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function buildBrowserHeaders(url?: string): Record<string, string> {
  const ua = randomUA();
  const headers: Record<string, string> = {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    DNT: "1",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };
  
  if (url) {
    try {
      const parsed = new URL(url);
      headers["Referer"] = `${parsed.protocol}//${parsed.hostname}/`;
    } catch {}
  }
  
  return headers;
}

export function buildDDGHeaders(): Record<string, string> {
  return buildBrowserHeaders();
}

export interface FetchResult {
  readonly html: string;
  readonly finalUrl: string;
  readonly contentType?: string;
  readonly rawBuffer?: Buffer;
}

const FETCH_TIMEOUT_MS = 12000;
const FETCH_MAX_RETRIES = 3;

// Proxy support (optional)
const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
const proxyAgent = PROXY_URL ? new (require("https-proxy-agent").HttpsProxyAgent)(PROXY_URL) : undefined;

export interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
}

export async function fetchPage(
  url: string, 
  signal: AbortSignal, 
  options: FetchOptions = {}
): Promise<FetchResult> {
  if (isPrivateUrl(url)) throw new Error("SSRF Guard: Blocked internal URL");

  let lastError: unknown;
  const { method = 'GET', body, headers: customHeaders = {} } = options;

  for (let attempt = 0; attempt < FETCH_MAX_RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    // Delay to prevent burst blocking
    await new Promise((resolve) => setTimeout(resolve, 2500));

    try {
      const headers = { ...buildBrowserHeaders(url), ...customHeaders };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      
      const res = await fetch(url, { 
        method, 
        body,
        signal: controller.signal, 
        headers, 
        redirect: "follow"
      });
      
      clearTimeout(timeout);

      // If blocked by Cloudflare/WAF, fall back to Wayback Machine immediately
      if ([403, 429, 503].includes(res.status)) {
        throw new Error(`HTTP ${res.status}`);
      }

      const contentType = res.headers.get("content-type") || "";
      const finalUrl = res.url || url;

      if (contentType.includes("application/pdf") || contentType.includes("application/octet-stream")) {
        const arrayBuf = await res.arrayBuffer();
        return { html: "", finalUrl, contentType, rawBuffer: Buffer.from(arrayBuf) };
      }

      const html = await res.text();
      
      // Only check for very specific captcha markers, avoid generic words like "blocked"
      if (html.includes("cf-challenge") || html.includes("hcaptcha") || html.includes("recaptcha")) {
        throw new Error("Captcha page detected");
      }

      return { html, finalUrl, contentType };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      lastError = err;
      
      // Exponential backoff
      const backoffTime = 5000 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, backoffTime));
    }
  }

  // If direct fetch fails, try 10 Web Archives
  return fetchFromArchives(url, signal);
}

async function fetchFromArchives(url: string, signal: AbortSignal): Promise<FetchResult> {
  const encoded = encodeURIComponent(url);
  const archives = [
    `https://web.archive.org/web/2/${url}`,
    `https://webcache.googleusercontent.com/search?q=cache:${encoded}&strip=1`,
    `https://archive.today/newest/${url}`,
    `https://cc.bingj.com/cache.aspx?q=${url}`,
    `https://webcache.googleusercontent.com/search?q=cache:${url}`,
    `http://web.archive.org/web/2024/${url}`,
    `https://freezedry.com/${url}`,
    `https://corsproxy.io/?${encoded}`,
    `https://api.allorigins.win/raw?url=${encoded}`,
    `https://cors-anywhere.herokuapp.com/${url}`
  ];

  for (const cacheUrl of archives) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(cacheUrl, { 
        signal: controller.signal, 
        headers: buildBrowserHeaders(cacheUrl)
      });
      clearTimeout(timeout);
      
      if (res.ok) {
        const html = await res.text();
        if (html.length > 500) {
          return { html, finalUrl: url, contentType: res.headers.get("content-type") || "" };
        }
      }
    } catch {}
  }

  throw new Error(`Failed to fetch ${url}: Blocked and all archives failed`);
}

export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}