// src/net/ddg.ts
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

  // ddgr strategy: POST form data to lite.duckduckgo.com/lite/
  const url = "https://lite.duckduckgo.com/lite/";
  const safeParam = safeSearch === "strict" ? "1" : safeSearch === "off" ? "-1" : "0";
  const dfParam = timeRange === "all" ? "" : `&df=${timeRange}`;
  
  // DDG Lite expects form data
  const formData = `q=${encodeURIComponent(query)}&kp=${safeParam}${dfParam}`;

  try {
    const res = await fetchPage(url, signal!, {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://lite.duckduckgo.com/"
      }
    });
    return parseDDGResults(res.html, maxResults);
  } catch (err) {
    throw new Error(`DDG fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  
  // ddgr lite HTML structure parsing
  // Lite version provides direct URLs, no redirect wrapping
  const resultRe = /<a rel="nofollow" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td class="result-snippet">([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  
  while (hits.length < maxResults && (match = resultRe.exec(html)) !== null) {
    let url = match[1];
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    const snippet = match[3].replace(/<[^>]+>/g, "").trim();
    
    // Filter out DDG internal links
    if (url.includes("duckduckgo.com")) continue;
    if (!url.startsWith("http")) continue;
    
    if (seen.has(url)) continue;
    seen.add(url);
    
    hits.push({ url, title, snippet }); 
  }
  
  return hits;
}