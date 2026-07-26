import { fetchPage } from "./http";

export class DdgRateLimiter {
  private lastRequest = 0;
  private minDelay: number;

  constructor(minDelayMs: number) {
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

export const sharedDdgLimiter = new DdgRateLimiter(2000);

export class DdgLimiterPool {
  private limiters: DdgRateLimiter[] = [];
  private currentIndex = 0;

  constructor(numLanes: number, minDelayMs: number) {
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

export function resetThrottle(): void {
  // Placeholder to satisfy imports; state is managed per-instance by DdgLimiterPool
}

export async function searchDDG(
  query: string,
  maxResults: number,
  safeSearch: "strict" | "moderate" | "off" = "moderate",
  signal?: AbortSignal,
  limiter?: DdgRateLimiter,
  timeRange: string = "all",
): Promise<ReadonlyArray<{ url: string; title: string; snippet: string }>> {
  if (limiter) await limiter.acquire();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const safeParam = safeSearch === "strict" ? "1" : safeSearch === "off" ? "-1" : "0";
  const dfParam = timeRange === "all" ? "" : `&df=${timeRange}`;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kp=${safeParam}${dfParam}`;

  try {
    const res = await fetchPage(url, signal!);
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
  timeRange: string = "all",
): Promise<ReadonlyArray<{ url: string; title: string; snippet: string }>> {
  const allHits: { url: string; title: string; snippet: string }[] = [];
  const safeParam = safeSearch === "strict" ? "1" : safeSearch === "off" ? "-1" : "0";
  const dfParam = timeRange === "all" ? "" : `&df=${timeRange}`;

  for (let p = 1; p <= pages; p++) {
    if (signal?.aborted) break;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&s=${(p - 1) * maxResultsPerPage}&kp=${safeParam}${dfParam}`;
    try {
      if (limiter) await limiter.acquire();
      const res = await fetchPage(url, signal!);
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
  
  const resultRe = /<a class="result__url[^>]*>([^<]*)<\/a>[\s\S]*?<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  
  while (hits.length < maxResults && (match = resultRe.exec(html)) !== null) {
    const url = match[1].trim();
    const snippet = match[2].replace(/<[^>]+>/g, "").trim();
    
    if (!url.startsWith("http")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    
    hits.push({ url, title: url, snippet }); 
  }
  
  return hits;
}