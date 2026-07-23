/**
 * @file net/ddg.ts
 * DuckDuckGo search scraper with:
 * - Adaptive throttle: shared error counter across all lanes - when DDG
 *   starts failing, ALL lanes back off exponentially and add jitter
 * - Global cooldown: after N consecutive failures, pause everything
 * - Per-lane rate limiting with staggered offsets
 * - Pagination support
 * - Query length enforcement (DDG chokes on 100+ char queries)
 */

import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { DDG_RATE_LIMIT_MS } from "../constants";
import { SearchHit } from "../types";
import { sleep, fetchInsecure } from "./http";
import { searchBrave, searchMojeek } from "./search-engines";

function randomUA(): string {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
}

export function buildDDGHeaders(): Record<string, string> {
  return {
    "User-Agent": randomUA(),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    DNT: "1",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };
}

const turndownService = new TurndownService();

const DDG_INTERNAL = /duckduckgo\.com|bing\.com/;

/** Max query length sent to DDG - longer queries get trimmed. */
const MAX_QUERY_LENGTH = 80;

/** Trim a query to fit DDG's sweet spot without cutting mid-word. */
function trimQuery(query: string): string {
  if (query.length <= MAX_QUERY_LENGTH) return query;
  const cut = query.slice(0, MAX_QUERY_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
}

class AdaptiveThrottle {
  private consecutiveErrors = 0;
  private cooldownUntil = 0;

  /** Call after a successful DDG response. */
  reportSuccess(): void {
    this.consecutiveErrors = Math.max(0, this.consecutiveErrors - 1);
  }

  /** Call after a failed DDG request. Returns extra delay (ms) to add. */
  reportError(): number {
    this.consecutiveErrors++;

    if (this.consecutiveErrors >= 5) {
      const cooldownMs = Math.min(30_000, this.consecutiveErrors * 3_000);
      this.cooldownUntil = Date.now() + cooldownMs;
      return cooldownMs;
    }
    return Math.min(15_000, 1000 * Math.pow(2, this.consecutiveErrors - 1));
  }

  /** Extra delay all lanes should wait right now (0 if no pressure). */
  currentPenalty(): number {
    const cooldownRemaining = this.cooldownUntil - Date.now();
    if (cooldownRemaining > 0) return cooldownRemaining;

    if (this.consecutiveErrors >= 2) {
      return Math.min(8_000, this.consecutiveErrors * 800);
    }

    return 0;
  }

  get errorCount(): number {
    return this.consecutiveErrors;
  }
}

/** Singleton - shared across all lanes and workers in a run. */
const globalThrottle = new AdaptiveThrottle();

export class DdgRateLimiter {
  private readonly baseDelayMs: number;
  private lastRequestAt: number = 0;
  private queue: Array<() => void> = [];
  private processing = false;
  private readonly jitterMs: number;

  constructor(baseDelayMs: number = DDG_RATE_LIMIT_MS) {
    this.baseDelayMs = baseDelayMs;
    this.jitterMs = Math.floor(Math.random() * 600);
  }

  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      if (!this.processing) this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const penalty = globalThrottle.currentPenalty();
      const effectiveDelay = this.baseDelayMs + this.jitterMs + penalty;

      const now = Date.now();
      const wait = Math.max(0, effectiveDelay - (now - this.lastRequestAt));
      if (wait > 0) await sleep(wait);

      this.lastRequestAt = Date.now();
      const resolve = this.queue.shift();
      resolve?.();
    }
    this.processing = false;
  }
}

/** Default shared limiter (single lane). */
export const sharedDdgLimiter = new DdgRateLimiter();

/**
 * Pool of N independent rate limiters with staggered start offsets.
 * Each lane has its own jitter, and all lanes respect the global
 * adaptive throttle.
 */
export class DdgLimiterPool {
  private readonly limiters: DdgRateLimiter[];
  private nextIdx = 0;

  constructor(laneCount: number, msPerLane: number) {
    this.limiters = [];
    for (let i = 0; i < laneCount; i++) {
      const stagger = Math.floor(msPerLane * 0.2 * i);
      this.limiters.push(new DdgRateLimiter(msPerLane + stagger));
    }
  }

  next(): DdgRateLimiter {
    const limiter = this.limiters[this.nextIdx % this.limiters.length];
    this.nextIdx++;
    return limiter;
  }

  get laneCount(): number {
    return this.limiters.length;
  }
}

/** Reset adaptive throttle - call at the start of a new research session. */
export function resetThrottle(): void {
  (globalThrottle as any).consecutiveErrors = 0;
  (globalThrottle as any).cooldownUntil = 0;
}

export async function searchDDG(
  query: string,
  maxResults: number,
  safeSearch: "strict" | "moderate" | "off",
  signal: AbortSignal,
  limiter: DdgRateLimiter = sharedDdgLimiter,
  timeRange: string = "all",
  page: number = 1,
): Promise<ReadonlyArray<SearchHit>> {
  const trimmed = trimQuery(query);
  await limiter.acquire();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const offset = (page - 1) * maxResults;
  console.log(`(DDG) Query: '${query}' (offset: ${offset}, limit: ${maxResults})`);

  if (page <= 1) {
    try {
      const hits = await tryHtmlEndpoint(
        trimmed,
        maxResults,
        safeSearch,
        signal,
		timeRange,
      );
      if (hits.length > 0) {
        console.log(`(HTML) Success: ${hits.length} results`);
        globalThrottle.reportSuccess();
        return hits;
      }
    } catch { }
  }

  try {
    const hits = await tryLiteEndpoint(
      trimmed,
      maxResults,
      safeSearch,
      signal,
      offset,
	  timeRange, 
    );
    if (hits.length > 0) {
      console.log(`(Lite) Success: ${hits.length} results`);
      globalThrottle.reportSuccess();
      return hits;
    }
  } catch { }

  const penalty = globalThrottle.reportError();
  
  try {
    console.log(`(Fallback) DDG failed, trying Brave Search for: "${trimmed}"`);
    const braveHits = await searchBrave(trimmed, maxResults, signal, limiter,timeRange);
    if (braveHits.length > 0) {
      console.log(`(Brave) Fallback success: ${braveHits.length} results`);
      return braveHits;
    }
  } catch { }

  try {
    const mojeekHits = await searchMojeek(trimmed, maxResults, signal, limiter);
    if (mojeekHits.length > 0) {
      console.log(`(Mojeek) Fallback success: ${mojeekHits.length} results`);
      return mojeekHits;
    }
  } catch { }

  if (penalty > 0 && !signal.aborted) {
    await sleep(Math.min(penalty, 5_000));
  }

  return [];
}

/**
Fetch multiple pages of results for a single query.
*/
export async function searchDDGPaginated(
  query: string,
  maxResultsPerPage: number,
  pages: number,
  safeSearch: "strict" | "moderate" | "off",
  signal: AbortSignal,
  limiter: DdgRateLimiter = sharedDdgLimiter,
  timeRange: string = "all",
): Promise<ReadonlyArray<SearchHit>> {
  const allHits: SearchHit[] = [];
  const seen = new Set<string>();
  for (let p = 1; p <= pages; p++) {
    if (signal.aborted) break;
    if (p > 1 && globalThrottle.errorCount >= 3) break;
    
    const hits = await searchDDG(
      query,
      maxResultsPerPage,
      safeSearch,
      signal,
      limiter,
      timeRange,
      p,
    );
    
    console.log(`(DDG) ${query} -> ${hits.length} results`);
    for (const h of hits) {
      if (!seen.has(h.url)) {
        seen.add(h.url);
        allHits.push(h);
      }
    }
    if (hits.length < maxResultsPerPage * 0.5) break;
  }
  return allHits;
}

async function tryLiteEndpoint(
  query: string,
  maxResults: number,
  safeSearch: "strict" | "moderate" | "off",
  signal: AbortSignal,
  offset: number = 0,
  timeRange: string = "all",
): Promise<ReadonlyArray<SearchHit>> {
  const url = "https://lite.duckduckgo.com/lite/";
  let body = `q=${encodeURIComponent(query)}`;
  if (safeSearch === "strict") body += "&p=-1";
  if (safeSearch === "off") body += "&p=1";
  if (offset > 0) {
    body += `&s=${offset}&dc=${Math.floor(offset / maxResults) + 1}`;
  }
  
  // Clean time filter application (no trailing spaces, proper &&)
  const dfMap: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };
  if (timeRange !== "all" && dfMap[timeRange]) {
    body += `&df=${dfMap[timeRange]}`;
  }

  console.log(`(Lite) Fetching '${url}?${body}' (POST)`);
  const html = await fetchInsecure(url, {
    ...buildDDGHeaders(),
    "Content-Type": "application/x-www-form-urlencoded",
  }, signal, body);
  return parseLiteResults(html, maxResults);
}

async function tryHtmlEndpoint(
  query: string,
  maxResults: number,
  safeSearch: "strict" | "moderate" | "off",
  signal: AbortSignal,
  timeRange: string = "all",
): Promise<ReadonlyArray<SearchHit>> {
  // 1. Declare 'url' FIRST so it can be used below
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  if (safeSearch === "strict") url.searchParams.set("p", "-1");
  if (safeSearch === "off") url.searchParams.set("p", "1");

  // 2. Apply time filter cleanly
  const dfMap: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };
  if (timeRange !== "all" && dfMap[timeRange]) {
    url.searchParams.set("df", dfMap[timeRange]);
  }

  console.log(`(HTML) Fetching '${url.toString()}'`);
  const html = await fetchInsecure(url.toString(), buildDDGHeaders(), signal);
  return parseHtmlResults(html, maxResults);
}

function parseLiteResults(
  html: string,
  maxResults: number,
): ReadonlyArray<SearchHit> {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  let resultLinks = doc.querySelectorAll("a.result-link");
  if (resultLinks.length === 0) resultLinks = doc.querySelectorAll(".result-link");
  if (resultLinks.length === 0) resultLinks = doc.querySelectorAll(".links_main a");
  if (resultLinks.length === 0) resultLinks = doc.querySelectorAll("a[href*='uddg=']");
  
  for (const link of Array.from(resultLinks)) {
    if (hits.length >= maxResults) break;
    let rawUrl = (link as HTMLAnchorElement).href || "";
    const title = link.textContent?.trim() || "";
    const row = link.closest("tr");
    const snippetEl = row?.nextElementSibling?.querySelector(".result-snippet") || row?.querySelector(".result-snippet");
    const snippet = snippetEl ? turndownService.turndown(snippetEl.innerHTML).replace(/\s+/g, " ").trim() : title;
    
    const uddgMatch = /[?&]uddg=([^&]+)/.exec(rawUrl);
    if (uddgMatch) {
      try { rawUrl = decodeURIComponent(uddgMatch[1]); } catch { /* ignore */ }
    } else {
      try { rawUrl = decodeURIComponent(rawUrl); } catch { /* ignore */ }
    }
    
    if (!rawUrl.startsWith("http") || DDG_INTERNAL.test(rawUrl)) continue;
    if (seen.has(rawUrl)) continue;
    
    seen.add(rawUrl);
    hits.push({ url: rawUrl, title, snippet });
  }
  console.log(`(Lite) ${hits.length} parsed (html length: ${html.length})`);
  return hits;
}

function parseHtmlResults(
  html: string,
  maxResults: number,
): ReadonlyArray<SearchHit> {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const results = doc.querySelectorAll(".result");
  
  for (const res of Array.from(results)) {
    if (hits.length >= maxResults) break;
    const link = res.querySelector(".result__a") as HTMLAnchorElement;
    if (!link) continue;
    
    let rawUrl = link.href || "";
    const title = link.textContent?.trim() || "";
    const snippetEl = res.querySelector(".result__snippet");
    const snippet = snippetEl ? turndownService.turndown(snippetEl.innerHTML).replace(/\s+/g, " ").trim() : title;
    
    const uddgMatch = /[?&]uddg=([^&]+)/.exec(rawUrl);
    if (uddgMatch) {
      try { rawUrl = decodeURIComponent(uddgMatch[1]); } catch { /* ignore */ }
    } else {
      try { rawUrl = decodeURIComponent(rawUrl); } catch { /* ignore */ }
    }
    
    if (!rawUrl.startsWith("http") || DDG_INTERNAL.test(rawUrl)) continue;
    if (seen.has(rawUrl)) continue;
    
    seen.add(rawUrl);
    hits.push({ url: rawUrl, title, snippet });
  }
  
  if (hits.length === 0) return parseLegacy(html, maxResults);
  return hits;
}

function parseLegacy(
  html: string,
  maxResults: number,
): ReadonlyArray<SearchHit> {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const links = doc.querySelectorAll("a[href]");
  
  for (const link of Array.from(links)) {
    if (hits.length >= maxResults) break;
    const href = (link as HTMLAnchorElement).href;
    if (!href) continue;
    try {
      const rawUrl = decodeURIComponent(href);
      const title = link.textContent?.trim() || "";
      if (DDG_INTERNAL.test(rawUrl)) continue;
      if (!rawUrl.startsWith("http")) continue;
      if (seen.has(rawUrl)) continue;
      seen.add(rawUrl);
      hits.push({ url: rawUrl, title, snippet: title });
    } catch {
      continue;
    }
  }
  return hits;
}