import { SearchHit } from "../types";
import { buildBrowserHeaders, sleep } from "./http";
import { DdgRateLimiter } from "./ddg";
import { loadUserKeys } from "../config/keys";

const X_DELAY_MS = 8000;

function crossrefUserAgent(): string {
  const mailto = loadUserKeys().crossrefMailto || "deepswarm-research@localhost.invalid";
  return `DeepSwarmResearch/5.2.1 (mailto:${mailto})`;
}

// --- SERPER API (Google) ---
export async function searchSerper(
  query: string,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal,
  limiter?: DdgRateLimiter,
): Promise<ReadonlyArray<SearchHit>> {
  if (limiter) await limiter.acquire();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: maxResults }),
      signal,
    });
    if (!res.ok) {
      console.error(`[searchSerper] HTTP ${res.status} ${res.statusText}`);
      return [];
    }
    const data = (await res.json()) as any;
    return (data.organic ?? []).map((r: any) => ({
      url: r.link,
      title: r.title,
      snippet: r.snippet ?? "",
      discoveredBy: "serper",
    }));
  } catch (err) {
    console.error(
      `[searchSerper] ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// --- BRAVE API (Web & News) ---
export async function searchBraveApi(
  query: string,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal,
  limiter?: DdgRateLimiter,
  isNews: boolean = false,
): Promise<ReadonlyArray<SearchHit>> {
  if (limiter) await limiter.acquire();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    const endpoint = isNews
      ? "https://api.search.brave.com/res/v1/news/search"
      : "https://api.search.brave.com/res/v1/web/search";
    const url = `${endpoint}?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const res = await fetch(url, {
      headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
      signal,
    });
    if (!res.ok) {
      console.error(`[searchBraveApi] HTTP ${res.status} ${res.statusText}`);
      return [];
    }
    const data = (await res.json()) as any;
    return (data.results ?? []).map((r: any) => ({
      url: r.url,
      title: r.title,
      snippet: r.description ?? "",
      discoveredBy: "brave-api",
    }));
  } catch (err) {
    console.error(
      `[searchBraveApi] ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// --- ACADEMIC APIs ---
export async function searchOpenAlex(
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) return [];
  try {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${maxResults}`;
    const res = await fetch(url, { signal });
    if (!res.ok) {
      console.error(`[searchOpenAlex] HTTP ${res.status} ${res.statusText}`);
      return [];
    }
    const data = (await res.json()) as any;
    return (data.results ?? []).map((r: any) => ({
      url: r.doi
        ? `https://doi.org/${r.doi.replace(/^https?:\/\/doi\.org\//i, "")}`
        : r.id,
      title: r.title ?? "Untitled",
      snippet: r.abstract_inverted_index
        ? Object.keys(r.abstract_inverted_index).slice(0, 60).join(" ")
        : "",
      discoveredBy: "openalex",
    }));
  } catch (err) {
    console.error(
      `[searchOpenAlex] ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

export async function searchCrossref(
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) return [];
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${maxResults}`;
    const res = await fetch(url, {
      signal,
      headers: {
        "User-Agent": crossrefUserAgent(),
      },
    });
    if (!res.ok) {
      console.error(`[searchCrossref] HTTP ${res.status} ${res.statusText}`);
      return [];
    }
    const data = (await res.json()) as any;
    return (data.message?.items ?? []).map((r: any) => ({
      url: r.URL,
      title: r.title?.[0] ?? "Untitled",
      snippet: r.abstract ? r.abstract.replace(/<[^>]+>/g, " ") : "",
      discoveredBy: "crossref",
    }));
  } catch (err) {
    console.error(
      `[searchCrossref] ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

export async function searchArxiv(
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) return [];
  try {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${maxResults}`;
    const res = await fetch(url, { signal });
    if (!res.ok) {
      console.error(`[searchArxiv] HTTP ${res.status} ${res.statusText}`);
      return [];
    }
    const xml = await res.text();
    const hits: SearchHit[] = [];
    const entries = xml.split("<entry>").slice(1);
    for (const entry of entries) {
      const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
      const urlMatch = entry.match(/<id>([\s\S]*?)<\/id>/);
      const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
      if (urlMatch && titleMatch) {
        hits.push({
          url: urlMatch[1].trim(),
          title: titleMatch[1].trim().replace(/\s+/g, " "),
          snippet: summaryMatch
            ? summaryMatch[1].trim().replace(/\s+/g, " ").slice(0, 300)
            : "",
          discoveredBy: "arxiv",
        });
      }
    }
    return hits;
  } catch (err) {
    console.error(
      `[searchArxiv] ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// --- GDELT NEWS ---
export async function searchGdelt(
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) return [];
  
  // Use a 4-second delay to prevent GDELT 429 bans
  await new Promise((resolve) => setTimeout(resolve, 4000));
  
  try {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=${maxResults}&format=json`;
    const res = await fetch(url, { signal });
    if (!res.ok) {
      console.error(`[searchGdelt] HTTP ${res.status} ${res.statusText}`);
      return [];
    }
    const data = (await res.json()) as any;
    return (data.articles ?? []).map((r: any) => ({
      url: r.url,
      title: r.title ?? "",
      snippet: r.title ?? "",
      discoveredBy: "gdelt",
    }));
  } catch (err) {
    console.error(
      `[searchGdelt] ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}



// --- REFERENCE / ENCYCLOPEDIAS ---
function addReferenceHit(
  hits: SearchHit[],
  seen: Set<string>,
  url: string,
  title: string,
  source: string,
  maxResults: number,
): void {
  if (hits.length >= maxResults) return;
  if (seen.has(url)) return;
  seen.add(url);
  hits.push({
    url,
    title: title.replace(/<[^>]+>/g, "").trim(),
    snippet: "",
    discoveredBy: source,
  });
}

function scrapeLinks(
  html: string,
  regex: RegExp,
  source: string,
  maxResults: number,
  hits: SearchHit[],
  seen: Set<string>,
  skipSearchLinks = false,
): void {
  let m: RegExpExecArray | null;
  while (hits.length < maxResults && (m = regex.exec(html)) !== null) {
    const u = m[1];
    if (skipSearchLinks && u.includes("/search?")) continue;
    addReferenceHit(hits, seen, u, m[2], source, maxResults);
  }
}

export async function searchReferenceSites(
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<ReadonlyArray<SearchHit>> {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  // 1. Grokipedia
  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const url = `https://grokipedia.com/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal,
      headers: buildBrowserHeaders(url),
    });
    if (res.ok) {
      const html = await res.text();
      const linkRe =
        /<a[^>]+href="\/(?:page|wiki)\/([^"#?]+)"[^>]*data-search-snippet="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while (hits.length < maxResults && (m = linkRe.exec(html)) !== null) {
        const slug = m[1];
        if (!slug) continue;
        const canonical = `https://grokipedia.com/page/${slug}`;
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const inner = m[3] ?? "";
        const titleSpan =
          inner.match(
            /<span[^>]*class="[^"]*(?:truncate|font-medium)[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
          )?.[1] ?? "";
        hits.push({
          url: canonical,
          title: (titleSpan || inner).replace(/<[^>]+>/g, "").trim(),
          snippet: (m[2] ?? "").trim(),
          discoveredBy: "grokipedia",
        });
      }
    }
  } catch {}

  // 2. Encyclopedia.com
  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const url = `https://www.encyclopedia.com/gsearch?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal,
      headers: buildBrowserHeaders(url),
    });
    if (res.ok) {
      const html = await res.text();
      const linkRe =
        /<a[^>]+href="(https:\/\/www\.encyclopedia\.com\/[^"]+)"[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      scrapeLinks(html, linkRe, "encyclopedia", maxResults, hits, seen);
    }
  } catch {}

  // 3. Britannica
  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const url = `https://www.britannica.com/search?query=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal,
      headers: buildBrowserHeaders(url),
    });
    if (res.ok) {
      const html = await res.text();
      const linkRe =
        /<a[^>]+href="(https:\/\/www\.britannica\.com\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      scrapeLinks(html, linkRe, "britannica", maxResults, hits, seen, true);
    }
  } catch {}

  return hits;
}