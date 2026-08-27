import { fetchPage } from "./http";

export class DdgRateLimiter {
  private lastRequest = 0;
  private minDelay: number;

  constructor(minDelayMs: number = 2500) {
    this.minDelay = minDelayMs;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minDelay) {
      await new Promise((resolve) => setTimeout(resolve, this.minDelay - elapsed));
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

/**
 * Bulletproof multi-tier DDG Search Waterfall:
 * Tier A: DDG Lite POST endpoint (fastest, mimics ddgr)
 * Tier B: DDG HTML fallback endpoint (handles strict blocks)
 * Tier C: Graceful recovery (returns empty array instead of throwing crash errors)
 */
export async function searchDDG(
  query: string,
  maxResults: number,
  safeSearch: "strict" | "moderate" | "off" = "moderate",
  signal?: AbortSignal,
  limiter?: DdgRateLimiter,
  timeRange: string = "all"
): Promise<ReadonlyArray<{ url: string; title: string; snippet: string }>> {
  if (limiter) await limiter.acquire();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const safeParam = safeSearch === "strict" ? "1" : safeSearch === "off" ? "-1" : "0";
  const dfParam = timeRange === "all" ? "" : `&df=${timeRange}`;
  const formData = `q=${encodeURIComponent(query)}&kp=${safeParam}${dfParam}`;

  // TIER A: DDG Lite Endpoint
  try {
    const res = await fetchPage("https://lite.duckduckgo.com/lite/", signal!, {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://lite.duckduckgo.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      }
    });
    const hits = parseDDGResults(res.html, maxResults);
    if (hits.length > 0) return hits;
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(`[DDG Tier A] Failed for query "${query}": ${err instanceof Error ? err.message : String(err)}. Trying Tier B...`);
  }

  // TIER B: DDG HTML Endpoint Fallback
  try {
    if (limiter) await limiter.acquire();
    const htmlFallbackUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resB = await fetchPage(htmlFallbackUrl, signal!, {
      method: "GET",
      headers: {
        "Referer": "https://html.duckduckgo.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      }
    });
    const hitsB = parseHTMLDDGResults(resB.html, maxResults);
    if (hitsB.length > 0) return hitsB;
  } catch (errB) {
    if (signal?.aborted) throw errB;
    console.warn(`[DDG Tier B] Fallback also failed for query "${query}": ${errB instanceof Error ? errB.message : String(errB)}`);
  }

  // TIER C: Graceful exit (Returns empty array so the worker's outer health system handles it cleanly without crashing)
  return [];
}

export async function searchDDGPaginated(
  query: string,
  maxResultsPerPage: number,
  pages: number,
  safeSearch: "strict" | "moderate" | "off" = "moderate",
  signal?: AbortSignal,
  limiter?: DdgRateLimiter,
  timeRange: string = "all"
): Promise<ReadonlyArray<{ url: string; title: string; snippet: string }>> {
  const allHits: { url: string; title: string; snippet: string }[] = [];

  for (let p = 1; p <= pages; p++) {
    if (signal?.aborted) break;
    
    const safeParam = safeSearch === "strict" ? "1" : safeSearch === "off" ? "-1" : "0";
    const dfParam = timeRange === "all" ? "" : `&df=${timeRange}`;
    const formData = `q=${encodeURIComponent(query)}&kp=${safeParam}${dfParam}&s=${(p - 1) * maxResultsPerPage}`;
    
    try {
      if (limiter) await limiter.acquire();
      const res = await fetchPage("https://lite.duckduckgo.com/lite/", signal!, {
        method: "POST",
        body: formData,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": "https://lite.duckduckgo.com/"
        }
      });
      const hits = parseDDGResults(res.html, maxResultsPerPage);
      allHits.push(...hits);
      if (hits.length < maxResultsPerPage) break;
    } catch {
      break;
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