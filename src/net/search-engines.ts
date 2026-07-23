/**
 * @file net/search-engines.ts
 * Multi-engine search - Brave Search, Google Scholar, SearXNG, Mojeek.
 * ALL are HTML-scraped, zero API keys required.
 * Combined with DDG to 2-4× the candidate pool.
 */

import { SearchHit } from "../types";
import { buildBrowserHeaders, sleep } from "./http";
import { DdgRateLimiter } from "./ddg";

export async function searchBrave(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  limiter?: DdgRateLimiter,
  timeRange: string = "all",
): Promise<ReadonlyArray<SearchHit>> {
  if (limiter) await limiter.acquire();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  try {
    const qdrMap: Record<string, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };
    const timeParam = timeRange !== "all" ? `&${qdrMap[timeRange] || "qdr:y"}` : "";
	const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web${timeParam}`;
    console.log(`(Brave) Fetching '${url}'`);
    const res = await fetch(url, {
      signal,
      headers: {
        ...buildBrowserHeaders(url),
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    console.log(`(Brave) Status ${res.status}`);
    if (!res.ok) return [];
    const html = await res.text();
    console.log(`(Brave) Fetched ${html.length} bytes`);
    return parseBraveResults(html, maxResults);
  } catch {
    return [];
  }
}

function getTimeFilterParams(timeRange: string, engine: SearchEngine): { querySuffix: string; urlParam: string } {
  if (timeRange === "all") return { querySuffix: "", urlParam: "" };

  switch (engine) {
    case "brave": {
      // Brave supports qdr:d (day), qdr:w (week), qdr:m (month), qdr:y (year)
      const braveMap: Record<string, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };
      return { querySuffix: ` ${braveMap[timeRange] || ""}`, urlParam: "" };
    }
    case "searxng": {
      // SearXNG supports time_range URL parameter
      const searxngMap: Record<string, string> = { day: "day", week: "week", month: "month", year: "year" };
      return { querySuffix: "", urlParam: searxngMap[timeRange] ? `&time_range=${searxngMap[timeRange]}` : "" };
    }
    case "scholar": {
      // Google Scholar uses as_ylo (year low) and as_yhi (year high)
      const currentYear = new Date().getFullYear();
      const yearMap: Record<string, string> = { 
        day: `${currentYear}`, week: `${currentYear}`, month: `${currentYear}`, year: `${currentYear - 1}` 
      };
      return { querySuffix: "", urlParam: `&as_ylo=${yearMap[timeRange] || currentYear}&as_yhi=${currentYear}` };
    }
    default:
      return { querySuffix: "", urlParam: "" };
  }
}

function parseBraveResults(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  const snippetBlockRe =
    /<div[^>]+class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*snippet|<footer)/gi;
  const linkRe = /href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const descRe =
    /<div[^>]+class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i;

  let blockMatch: RegExpExecArray | null;
  while (
    hits.length < maxResults &&
    (blockMatch = snippetBlockRe.exec(html)) !== null
  ) {
    const block = blockMatch[1];
    const lm = linkRe.exec(block);
    if (!lm) continue;

    const rawUrl = lm[1].trim();
    if (!rawUrl.startsWith("http") || seen.has(rawUrl)) continue;
    if (/brave\.com|search\.brave/i.test(rawUrl)) continue;
    seen.add(rawUrl);

    const title = stripTags(lm[2]).trim();
    const descMatch = descRe.exec(block);
    const snippet = descMatch ? stripTags(descMatch[1]).trim() : title;
    hits.push({ url: rawUrl, title, snippet });
  }

  if (hits.length === 0) {
    const fallbackRe =
      /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*heading[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while (hits.length < maxResults && (m = fallbackRe.exec(html)) !== null) {
      const rawUrl = m[1].trim();
      if (seen.has(rawUrl) || /brave\.com/i.test(rawUrl)) continue;
      seen.add(rawUrl);
      hits.push({ url: rawUrl, title: stripTags(m[2]).trim(), snippet: "" });
    }
  }

  return hits;
}

export async function searchGoogleScholar(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  limiter?: DdgRateLimiter,
): Promise<ReadonlyArray<SearchHit>> {
  if (limiter) await limiter.acquire();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  try {
    const url = `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}&hl=en&num=${Math.min(maxResults, 10)}`;
    const res = await fetch(url, {
      signal,
      headers: buildBrowserHeaders(url),
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseScholarResults(html, maxResults);
  } catch {
    return [];
  }
}

function parseScholarResults(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  const blockRe =
    /<div[^>]+class="[^"]*gs_r[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*gs_r|$)/gi;
  const titleLinkRe =
    /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRe = /<div[^>]+class="gs_rs"[^>]*>([\s\S]*?)<\/div>/i;

  let blockMatch: RegExpExecArray | null;
  while (
    hits.length < maxResults &&
    (blockMatch = blockRe.exec(html)) !== null
  ) {
    const block = blockMatch[1];
    const tm = titleLinkRe.exec(block);
    if (!tm) continue;

    let rawUrl = tm[1].trim();
    const urlParam = /[?&]url=(https?[^&]+)/.exec(rawUrl);
    if (urlParam) rawUrl = decodeURIComponent(urlParam[1]);

    if (!rawUrl.startsWith("http") || seen.has(rawUrl)) continue;
    if (/scholar\.google|google\.com\/scholar/i.test(rawUrl)) continue;
    seen.add(rawUrl);

    const title = stripTags(tm[2]).trim();
    const sm = snippetRe.exec(block);
    const snippet = sm ? stripTags(sm[1]).trim() : title;
    hits.push({ url: rawUrl, title, snippet });
  }

  return hits;
}

const SEARXNG_INSTANCES: ReadonlyArray<string> = [
  "https://search.sapti.me",
  "https://searx.tiekoetter.com",
  "https://search.bus-hit.me",
  "https://priv.au",
];

export async function searchSearXNG(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  limiter?: DdgRateLimiter,
  timeRange: string = "all",
): Promise<ReadonlyArray<SearchHit>> {
  if (limiter) await limiter.acquire();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  for (const instance of SEARXNG_INSTANCES) {
    if (signal.aborted) break;
    try {
      const timeParam = timeRange !== "all" ? `&time_range=${timeRange}` : "";
      const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=en${timeParam}`;
      const res = await fetch(url, {
        signal,
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });
      if (!res.ok) continue;

      const data = (await res.json()) as {
        results?: Array<{ url?: string; title?: string; content?: string }>;
      };
      if (!data.results || !Array.isArray(data.results)) continue;

      const hits: SearchHit[] = [];
      const seen = new Set<string>();
      for (const r of data.results) {
        if (hits.length >= maxResults) break;
        if (!r.url || !r.url.startsWith("http") || seen.has(r.url)) continue;
        seen.add(r.url);
        hits.push({
          url: r.url,
          title: r.title ?? "",
          snippet: r.content ?? r.title ?? "",
        });
      }
      if (hits.length > 0) return hits;
    } catch {
      continue;
    }
  }

  return [];
}

export async function searchMojeek(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  limiter?: DdgRateLimiter,
): Promise<ReadonlyArray<SearchHit>> {
  if (limiter) await limiter.acquire();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  try {
    const url = `https://www.mojeek.com/search?q=${encodeURIComponent(query)}&fmt=html`;
    const res = await fetch(url, {
      signal,
      headers: buildBrowserHeaders(url),
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseMojeekResults(html, maxResults);
  } catch {
    return [];
  }
}

function parseMojeekResults(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  const resultBlockRe =
    /<a[^>]+class="ob"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="ob"|$)/gi;
  const snippetRe = /<p[^>]+class="s"[^>]*>([\s\S]*?)<\/p>/i;

  let m: RegExpExecArray | null;
  while (hits.length < maxResults && (m = resultBlockRe.exec(html)) !== null) {
    const rawUrl = m[1].trim();
    const title = stripTags(m[2]).trim();
    const blockContent = m[3];

    if (!rawUrl.startsWith("http") || /mojeek\.com/i.test(rawUrl)) {
      continue;
    }

    if (seen.has(rawUrl)) continue;
    seen.add(rawUrl);

    const sm = snippetRe.exec(blockContent);
    const snippet = sm ? stripTags(sm[1]).trim() : title;

    hits.push({ url: rawUrl, title, snippet });
  }

  return hits;
}

export type SearchEngine = "ddg" | "brave" | "scholar" | "searxng" | "mojeek";

/**
 * Run a query across multiple engines in parallel and merge results.
 * Deduplicates by URL. Each engine gets its own limiter from the pool.
 */
export async function multiEngineSearch(
  query: string,
  maxResultsPerEngine: number,
  engines: ReadonlyArray<SearchEngine>,
  signal: AbortSignal,
  getLimiter: () => DdgRateLimiter,
  timeRange: string = "all",
): Promise<ReadonlyArray<SearchHit>> {
  const engineFns: Record<
    SearchEngine,
    (
      q: string,
      max: number,
      s: AbortSignal,
      l: DdgRateLimiter,
	  tr: string, 
    ) => Promise<ReadonlyArray<SearchHit>>
  > = {
    ddg: async () => [],
    brave: searchBrave,
    scholar: searchGoogleScholar,
    searxng: searchSearXNG,
    mojeek: searchMojeek,
  };

  const promises = engines
    .filter((e) => e !== "ddg")
    .map((engine) => {
      const fn = engineFns[engine];
      const limiter = getLimiter();
	  return fn(query, maxResultsPerEngine, signal, limiter, timeRange).catch(
         () => [] as SearchHit[],
      );
    });

  const results = await Promise.all(promises);

  const seen = new Set<string>();
  const merged: SearchHit[] = [];

  for (const engineHits of results) {
    for (const hit of engineHits) {
      if (!seen.has(hit.url)) {
        seen.add(hit.url);
        merged.push(hit);
      }
    }
  }

  return merged;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
