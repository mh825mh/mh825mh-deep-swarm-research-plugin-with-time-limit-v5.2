// src/net/decodoApi.ts
// Decodo Web Scraping API integration: a server-side fetch tier that resolves
// targets from Decodo's proxy pool. Used when the local network cannot reach a
// host directly (e.g. duckduckgo.com is TCP-blocked on this egress).
//
// Endpoint: POST https://scraper-api.decodo.com/v2/scrape
//   Authorization: Basic <TOKEN>
//   Body: { "target": "universal", "url": "<target>", "proxy_pool": "premium" }
//   Response: { "results": [ { "content": "<JSON-encoded HTML>", "status_code": 200 } ] }
import { isPrivateUrl } from "./ssrf";

export interface DecodoStats {
  configured: boolean;
  attempts: number;
  successes: number;
  failures: number;
  lastError: string | null;
}

const DECODO_ENDPOINT = "https://scraper-api.decodo.com/v2/scrape";
const DECODO_TIMEOUT_MS = 25_000;
const DECODO_MAX_CALLS_PER_RUN = 200;
const DECODO_MAX_CONSECUTIVE_FAILURES = 5;

const stats: DecodoStats = {
  configured: false,
  attempts: 0,
  successes: 0,
  failures: 0,
  lastError: null,
};

let decodoToken = "";
let callsMade = 0;
let consecutiveFailures = 0;
let disabled = false;

export function setDecodoToken(token: string | undefined): void {
  decodoToken = token?.trim() ?? "";
  stats.configured = decodoToken.length > 0;
  if (!stats.configured) stats.lastError = null;
}

export function isDecodoConfigured(): boolean {
  return decodoToken.length > 0 && !disabled;
}

export function resetDecodoSession(): void {
  callsMade = 0;
  consecutiveFailures = 0;
  disabled = false;
  stats.configured = decodoToken.length > 0;
  stats.attempts = 0;
  stats.successes = 0;
  stats.failures = 0;
  stats.lastError = null;
}

export function getDecodoStats(): Readonly<DecodoStats> {
  return { ...stats };
}

function noteFailure(error: string): void {
  stats.failures++;
  stats.lastError = error;
  consecutiveFailures++;
  if (consecutiveFailures >= DECODO_MAX_CONSECUTIVE_FAILURES) {
    disabled = true;
    stats.lastError = `${error} (disabled after ${DECODO_MAX_CONSECUTIVE_FAILURES} consecutive failures)`;
  }
}

/**
 * Fetches `url` through the Decodo Web Scraping API and returns the rendered
 * HTML, or null when Decodo is not configured / the request failed. Never
 * throws (a broken endpoint simply falls through to other tiers).
 */
export async function fetchViaDecodo(
  url: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!isDecodoConfigured()) return null;
  if (signal.aborted) return null;
  if (callsMade >= DECODO_MAX_CALLS_PER_RUN) {
    noteFailure(`per-run call cap reached (${DECODO_MAX_CALLS_PER_RUN})`);
    return null;
  }
  if (isPrivateUrl(url)) return null;

  callsMade++;
  stats.attempts++;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DECODO_TIMEOUT_MS);
  if (typeof (timer as NodeJS.Timeout).unref === "function") (timer as NodeJS.Timeout).unref();

  try {
    const res = await fetch(DECODO_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Basic ${decodoToken}`,
      },
      body: JSON.stringify({
        target: "universal",
        url,
        proxy_pool: "premium",
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      noteFailure(`Decodo API HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      results?: ReadonlyArray<{
        content?: unknown;
        status_code?: number;
      }>;
    };

    const first = data.results?.[0];
    const statusCode = first?.status_code ?? res.status;
    if (!first || statusCode < 200 || statusCode >= 300) {
      noteFailure(`Target HTTP ${statusCode}`);
      return null;
    }

    // `content` is a JSON-encoded string of the target HTML. Decode it;
    // if it is not valid JSON it is treated as raw HTML.
    let html: string;
    if (typeof first.content === "string") {
      try {
        const decoded = JSON.parse(first.content);
        html = typeof decoded === "string" ? decoded : JSON.stringify(decoded);
      } catch {
        html = first.content;
      }
    } else if (typeof first.content === "object" && first.content !== null) {
      html = JSON.stringify(first.content);
    } else {
      noteFailure("Decodo response missing content");
      return null;
    }

    if (!html || html.trim().length === 0) {
      noteFailure("Decodo returned empty content");
      return null;
    }

    stats.successes++;
    consecutiveFailures = 0;
    stats.lastError = null;
    return html;
  } catch (err) {
    if (signal.aborted) return null;
    if (err instanceof DOMException && err.name === "AbortError") return null;
    noteFailure(err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}