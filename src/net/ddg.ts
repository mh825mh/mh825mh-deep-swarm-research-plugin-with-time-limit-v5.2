import { fetchPage } from "./http";
import { fetchWithWaterfall } from "./waterfallFetcher";
import { fetchViaDecodo, isDecodoConfigured } from "./decodoApi";

// Module-level shared rate-limit backoff for DDG. Shared across ALL limiter
// instances, lanes, paginated pages and mutation queries so a 202 anywhere is
// honored everywhere ("do not retry the same IP immediately").
export const DDG_BACKOFF_BASE_MS = 8000;
export const DDG_BACKOFF_MAX_MS = 120000;
const backoffState = {
  consecutive: 0,
  nextAllowedAt: 0,
};
let searchRateLimited = false;

/** Pure backoff calc for tests: doubles from BASE, capped at MAX, ±15% jitter. */
export function ddgBackoffDelayMs(consecutive: number): number {
  const base = Math.min(DDG_BACKOFF_BASE_MS * Math.pow(2, consecutive), DDG_BACKOFF_MAX_MS);
  const jittered = base * (0.85 + Math.random() * 0.3);
  return Math.round(Math.min(jittered, DDG_BACKOFF_MAX_MS));
}

function noteDdgRateLimited(): void {
  backoffState.consecutive++;
  searchRateLimited = true;
  const delay = ddgBackoffDelayMs(backoffState.consecutive);
  backoffState.nextAllowedAt = Date.now() + delay;
  console.warn(`[DDG] Rate-limited (202): backing off ${delay}ms before next query.`);
}

function clearDdgBackoff(): void {
  if (backoffState.consecutive !== 0 || backoffState.nextAllowedAt !== 0 || searchRateLimited) {
    backoffState.consecutive = 0;
    backoffState.nextAllowedAt = 0;
    searchRateLimited = false;
  }
}

/** True when a 202 backoff is currently in effect; exported for tests. */
export function isDdgBackoffActive(): boolean {
  return Date.now() < backoffState.nextAllowedAt;
}

/** True when the most recent DDG search ended in a 202 rate-limit (even if it
 * later recovered through a fallback tier). Lets the health tracker record the
 * real cause instead of a generic 0-result set. */
export function wasLastSearchRateLimited(): boolean {
  return searchRateLimited;
}

async function waitOutBackoff(): Promise<void> {
  const remaining = backoffState.nextAllowedAt - Date.now();
  if (remaining <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

export class DdgRateLimiter {
  private lastRequest = 0;
  private minDelay: number;

  constructor(minDelayMs: number = 2500) {
    this.minDelay = minDelayMs;
  }

  async acquire(): Promise<void> {
    // Honor any shared 202 backoff first, then apply jittered inter-query pacing.
    await waitOutBackoff();
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    const jitteredDelay = this.minDelay * (1 + Math.random());
    if (elapsed < jitteredDelay) {
      await new Promise((resolve) => setTimeout(resolve, jitteredDelay - elapsed));
    }
    this.lastRequest = Date.now();
  }
}

export const sharedDdgLimiter = new DdgRateLimiter(2500);

export class DdgLimiterPool {
  private limiters: DdgRateLimiter[] = [];
  private currentIndex = 0;

  constructor(numLanes: number, minDelayMs: number = 2500) {
    for (let i = 0; i < numLanes; i++) {
      this.limiters.push(new DdgRateLimiter(minDelayMs));
    }
  }

  next(): DdgRateLimiter {
    const limiter = this.limiters[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.limiters.length;
    return limiter;
  }
}

export function resetThrottle(): void {}

/** Hard ceiling for a single DDG search so a blocked/throttled engine fails
 * fast instead of letting the watchdog kill the whole swarm. */
const DDG_SEARCH_CAP_MS = 25_000;
/** A remote fetch tier (Decodo) takes longer than direct HTML, so give it more
 * headroom when configured rather than letting the base cap fire first. */
const DDG_SEARCH_CAP_MS_WITH_DECODO = 45_000;

/**
 * Bulletproof multi-tier DDG Search Waterfall:
 * Tier A: DDG Lite POST endpoint (fastest, mimics ddgr)
 * Tier B: DDG HTML fallback endpoint (handles strict blocks)
 * Tier C: Graceful recovery (returns empty array instead of throwing crash errors)
 *
 * The whole waterfall (rate-limiter acquire + tier A + tier B + archive
 * fallbacks) is race-capped so no single query can monopolize a worker for
 * minutes when DDG is unresponsive.
 */
export async function searchDDG(
  query: string,
  maxResults: number,
  safeSearch: "strict" | "moderate" | "off" = "moderate",
  signal?: AbortSignal,
  limiter?: DdgRateLimiter,
  timeRange: string = "all",
  flaresolverrUrl?: string,
): Promise<ReadonlyArray<{ url: string; title: string; snippet: string }>> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  let capTimer: NodeJS.Timeout | null = null;
  const capMs = isDecodoConfigured() ? DDG_SEARCH_CAP_MS_WITH_DECODO : DDG_SEARCH_CAP_MS;
  const cap = new Promise<never>((_, reject) => {
    capTimer = setTimeout(
      () => reject(new Error(`DDG search cap exceeded (${capMs}ms) for query "${query.slice(0, 60)}"`)),
      capMs,
    );
    if (typeof capTimer.unref === "function") capTimer.unref();
  });

  try {
    return await Promise.race([
      searchDDGUncapped(query, maxResults, safeSearch, signal, limiter, timeRange, flaresolverrUrl),
      cap,
    ]);
  } finally {
    if (capTimer) clearTimeout(capTimer);
  }
}

function buildDdgHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    "Referer": "https://duckduckgo.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
}

async function searchDDGUncapped(
  query: string,
  maxResults: number,
  safeSearch: "strict" | "moderate" | "off",
  signal?: AbortSignal,
  limiter?: DdgRateLimiter,
  timeRange: string = "all",
  flaresolverrUrl?: string,
): Promise<ReadonlyArray<{ url: string; title: string; snippet: string }>> {
  if (limiter) await limiter.acquire();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  searchRateLimited = false;

  const safeParam = safeSearch === "strict" ? "1" : safeSearch === "off" ? "-1" : "0";
  const dfParam = timeRange === "all" ? "" : `&df=${timeRange}`;
  const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kp=${safeParam}${dfParam}`;
  const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kp=${safeParam}${dfParam}`;

  // When the local egress cannot reach DDG at all (TCP-blocked host/network,
  // e.g. duckduckgo.com on this machine), fetchPage will burn dozens of seconds
  // on connection retries + archives. Bound the direct tiers tightly so a
  // configured Decodo tier gets a chance within the outer search cap.
  const decodoReady = isDecodoConfigured();
  const directBudgetMs = decodoReady ? 7000 : undefined;

  // TIER A: DDG HTML Endpoint (primary) — HTML results page parsed directly;
  // preferred over the lite POST flow because the /html/ layout is stable and
  // returns the same result set. Still rate-limited: 202 -> back off, don't
  // hammer the same host right away.
  try {
    const res = await withBudget(fetchPage(htmlUrl, signal!, {
      method: "GET",
      headers: buildDdgHeaders(),
    }), directBudgetMs, "DDG Tier A");
    if (res.statusCode === 202) {
      noteDdgRateLimited();
    } else {
      const hits = parseHTMLDDGResults(res.html, maxResults);
      if (hits.length > 0) {
        clearDdgBackoff();
        return hits;
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(`[DDG Tier A] Failed for query "${query}": ${err instanceof Error ? err.message : String(err)}. Trying Tier B...`);
  }

  // TIER B: DDG Lite Endpoint Fallback — alternative layout when /html/ is
  // unreachable or blocked. Same HTML parsing, POST form feed like ddgr.
  try {
    if (limiter) await limiter.acquire();
    const resB = await withBudget(fetchPage("https://lite.duckduckgo.com/lite/", signal!, {
      method: "POST",
      body: `q=${encodeURIComponent(query)}&kp=${safeParam}${dfParam}`,
      headers: buildDdgHeaders(),
    }), directBudgetMs, "DDG Tier B");
    if (resB.statusCode === 202) {
      noteDdgRateLimited();
    } else {
      const hitsB = parseDDGResults(resB.html, maxResults);
      if (hitsB.length > 0) {
        clearDdgBackoff();
        return hitsB;
      }
    }
  } catch (errB) {
    if (signal?.aborted) throw errB;
    console.warn(`[DDG Tier B] Fallback also failed for query "${query}": ${errB instanceof Error ? errB.message : String(errB)}`);
  }

  // TIER B2: Decodo Web Scraping API — the local network cannot reach DDG
  // (TCP-blocked egress), so fetch the same HTML URL through Decodo's proxy
  // pool. Runs before FlareSolverr because a remote fetcher is far more likely
  // to share an unblocked egress. Parse the standard HTML layout afterwards.
  if (decodoReady && !signal?.aborted) {
    try {
      const decodoHtmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kp=1`;
      const decodoHtml = await fetchViaDecodo(decodoHtmlUrl, signal!);
      if (decodoHtml) {
        const hits = parseHTMLDDGResults(decodoHtml, maxResults);
        if (hits.length > 0) {
          clearDdgBackoff();
          return hits;
        }
      }
    } catch (errDecodo) {
      if (signal?.aborted) throw errDecodo;
      console.warn(`[DDG Tier B2] Decodo search fallback failed for query "${query}": ${errDecodo instanceof Error ? errDecodo.message : String(errDecodo)}`);
    }
  }

  // TIER C: FlareSolverr (headless browser) search fallback — when both direct
  // HTTP tiers are blocked/empty, DDG is usually being WAF'd. A FlareSolverr
  // request.get renders the search page in a real browser and sidesteps the
  // challenge. Parse the same HTML layouts afterwards.
  if (flaresolverrUrl && flaresolverrUrl.trim() !== "" && !signal?.aborted) {
    try {
      const fsHtmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kp=1`;
      const fsHtml = await fetchWithWaterfall(fsHtmlUrl, signal!, flaresolverrUrl);
      if (fsHtml) {
        const hits = parseHTMLDDGResults(fsHtml, maxResults);
        if (hits.length > 0) {
          clearDdgBackoff();
          return hits;
        }
      }
    } catch (errFs) {
      if (signal?.aborted) throw errFs;
      console.warn(`[DDG Tier C] FlareSolverr search fallback failed for query "${query}": ${errFs instanceof Error ? errFs.message : String(errFs)}`);
    }
  }

  // TIER D: Graceful exit (Returns empty array so the worker's outer health
  // system handles it cleanly without crashing). Surface whether DDG throttled
  // us so the health tracker records the real cause, not a fake 0-results set.
  if (isDdgBackoffActive()) {
    console.warn(`[DDG] Query "${query}" finished with an active 202 backoff — recorded as rate-limited.`);
  }
  return [];
}

/** Races a promise against a wall-clock budget. Returns the promise result or
 * rejects on budget exhaustion. `ms`-undefined/<=0 behaves like the plain promise. */
function withBudget<T>(
  task: Promise<T>,
  ms: number | undefined,
  label: string,
): Promise<T> {
  if (!ms || ms <= 0) return task;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${ms}ms budget`)),
      ms,
    );
    if (typeof (timer as NodeJS.Timeout).unref === "function") (timer as NodeJS.Timeout).unref();
    task.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function searchDDGPaginated(
  query: string,
  maxResultsPerPage: number,
  pages: number,
  safeSearch: "strict" | "moderate" | "off" = "moderate",
  signal?: AbortSignal,
  limiter?: DdgRateLimiter,
  timeRange: string = "all",
  flaresolverrUrl?: string,
): Promise<ReadonlyArray<{ url: string; title: string; snippet: string }>> {
  const allHits: { url: string; title: string; snippet: string }[] = [];
  searchRateLimited = false;

  // Bound the direct POST loop so a TCP-blocked egress falls through to the
  // Decodo/FlareSolverr tiers instead of burning the whole outer cap.
  const directBudgetForPage = isDecodoConfigured() ? 7000 : undefined;

  for (let p = 1; p <= pages; p++) {
    if (signal?.aborted) break;
    
    const safeParam = safeSearch === "strict" ? "1" : safeSearch === "off" ? "-1" : "0";
    const dfParam = timeRange === "all" ? "" : `&df=${timeRange}`;
    
    try {
      if (limiter) await limiter.acquire();
      const res = await withBudget(fetchPage("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query) + `&kp=${safeParam}${dfParam}&s=${(p - 1) * maxResultsPerPage}`, signal!, {
        method: "GET",
        headers: buildDdgHeaders(),
      }), directBudgetForPage, "DDG Paginated Tier A");
      if (res.statusCode === 202) {
        noteDdgRateLimited();
        break;
      }
      const hits = parseHTMLDDGResults(res.html, maxResultsPerPage);
      allHits.push(...hits);
      if (hits.length < maxResultsPerPage) break;
    } catch {
      break;
    }
  }

  // Paginated mode falls back to Decodo first (server-side fetch, workable
  // when the local egress is TCP-blocked), then FlareSolverr.
  if (allHits.length === 0 && !signal?.aborted) {
    if (isDecodoConfigured()) {
      try {
        const decodoHtmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kp=1`;
        const decodoHtml = await fetchViaDecodo(decodoHtmlUrl, signal!);
        if (decodoHtml) {
          const hits = parseHTMLDDGResults(decodoHtml, maxResultsPerPage);
          if (hits.length > 0) clearDdgBackoff();
          allHits.push(...hits);
        }
      } catch (errDecodo) {
        if (signal?.aborted) throw errDecodo;
        console.warn(`[DDG Paginated] Decodo search fallback failed for query "${query}": ${errDecodo instanceof Error ? errDecodo.message : String(errDecodo)}`);
      }
    }
  }
  if (allHits.length === 0 && flaresolverrUrl && flaresolverrUrl.trim() !== "" && !signal?.aborted) {
    try {
      const fsHtmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kp=1`;
      const fsHtml = await fetchWithWaterfall(fsHtmlUrl, signal!, flaresolverrUrl);
      if (fsHtml) {
        const hits = parseHTMLDDGResults(fsHtml, maxResultsPerPage);
        if (hits.length > 0) clearDdgBackoff();
        allHits.push(...hits);
      }
    } catch (errFs) {
      if (signal?.aborted) throw errFs;
      console.warn(`[DDG Paginated] FlareSolverr search fallback failed for query "${query}": ${errFs instanceof Error ? errFs.message : String(errFs)}`);
    }
  }

  return allHits;
}

function parseDDGResults(html: string, maxResults: number): { url: string; title: string; snippet: string }[] {
  const hits: { url: string; title: string; snippet: string }[] = [];
  const seen = new Set<string>();
  
  // Resilient regex pattern matching DDG Lite result rows
  const resultRe = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td class="result-snippet">([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  
  while (hits.length < maxResults && (match = resultRe.exec(html)) !== null) {
    let url = match[1];
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    const snippet = match[3].replace(/<[^>]+>/g, "").trim();
    
    // Clean up redirect wrappers if present
    if (url.includes("uddg=")) {
      const matchUrl = url.match(/uddg=([^&]+)/);
      if (matchUrl) url = decodeURIComponent(matchUrl[1]);
    }

    if (url.includes("duckduckgo.com")) continue;
    if (!url.startsWith("http")) continue;
    
    if (seen.has(url)) continue;
    seen.add(url);
    
    hits.push({ url, title, snippet });  
  }
  
  return hits;
}

function parseHTMLDDGResults(html: string, maxResults: number): { url: string; title: string; snippet: string }[] {
  const hits: { url: string; title: string; snippet: string }[] = [];
  const seen = new Set<string>();
  
  // Secondary parser for standard DDG HTML results page layout
  const resultRe = /<a class="result__url" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  
  while (hits.length < maxResults && (match = resultRe.exec(html)) !== null) {
    let url = match[1];
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    const snippet = match[3].replace(/<[^>]+>/g, "").trim();

    if (url.includes("duckduckgo.com")) continue;
    if (!url.startsWith("http") && url.startsWith("//")) url = "https:" + url;
    if (!url.startsWith("http")) continue;
    
    if (seen.has(url)) continue;
    seen.add(url);
    
    hits.push({ url, title, snippet });  
  }
  
  return hits;
}