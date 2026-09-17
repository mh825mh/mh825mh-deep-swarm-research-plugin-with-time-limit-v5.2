// src/net/search-engines.ts
import type { SearchHit } from "../types";
import { DdgRateLimiter, searchDDG } from "./ddg";
import { buildBrowserHeaders, fetchPage } from "./http";
import { searchRssFeeds } from "./rss-engine";
import { searchTelegram } from "./social-engines";
import {
  searchArxiv,
  searchBraveApi,
  searchCrossref,
  searchGdelt,
  searchOpenAlex,
  searchReferenceSites,
  searchSerper,
} from "./api-engines";

export type SearchEngine =
  | "bing"
  | "ddg"
  | "brave"
  | "google"
  | "scholar"
  | "searxng"
  | "mojeek"
  | "yandex"
  | "serper"
  | "brave-api"
  | "openalex"
  | "crossref"
  | "arxiv"
  | "gdelt"
  | "reference"
  | "youtube"
  | "rss"
  | "telegram";

export interface SearchEngineOptions {
  readonly serperApiKey?: string;
  readonly braveApiKey?: string;
  readonly rssFeedUrls?: ReadonlyArray<string>;
  readonly telegramChannels?: ReadonlyArray<string>;
}

export type LimiterFactory = () => DdgRateLimiter;

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDuckDuckGoUrl(value: string): string {
  try {
    const parsed = new URL(value, "https://duckduckgo.com");
    if (parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com")) {
      const target = parsed.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    }
  } catch {}
  return value;
}

function normaliseUrl(value: string): string {
  return decodeDuckDuckGoUrl(value).trim().replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();
}

function dedupeHits(hits: ReadonlyArray<SearchHit>, maxResults: number): ReadonlyArray<SearchHit> {
  const result: SearchHit[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const url = decodeDuckDuckGoUrl(hit.url);
    const key = normaliseUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ ...hit, url, title: hit.title?.trim() || url, snippet: hit.snippet?.trim() || "" });
    if (result.length >= maxResults) break;
  }
  return result;
}

function parseSearchLinks(html: string, source: string, maxResults: number): ReadonlyArray<SearchHit> {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const linkRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while (hits.length < maxResults && (match = linkRe.exec(html)) !== null) {
    const href = decodeDuckDuckGoUrl(match[1]);
    const title = stripHtml(match[2]);
    if (!href.startsWith("http")) continue;
    if (!title || title.length < 2) continue;
    const key = normaliseUrl(href);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    hits.push({ url: href, title, snippet: "", discoveredBy: source });
  }
  return hits;
}

// Serialized queue to prevent concurrent hits and ban patterns
class EngineQueue {
  private chain: Promise<any> = Promise.resolve();
  private lastRequest = 0;
  private readonly minDelay: number;

  constructor(minDelayMs: number = 4000) {
    this.minDelay = minDelayMs;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    // Enforce minimum delay between sequential requests
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minDelay) {
      const jitter = Math.random() * 1000; // add up to 1s of jitter to look human
      await new Promise((resolve) => setTimeout(resolve, this.minDelay - elapsed + jitter));
    }

    const runTask = this.chain.then(() => task());
    // Update chain to catch errors so one failure doesn't break the queue permanently
    this.chain = runTask.then(() => undefined, () => undefined);
    this.lastRequest = Date.now();
    return runTask;
  }
}

const engineQueues: Record<string, EngineQueue> = {
  ddg: new EngineQueue(4000),
  bing: new EngineQueue(3500),
  brave: new EngineQueue(3500),
  google: new EngineQueue(5000), // Google is strict, needs 5s
  scholar: new EngineQueue(5000),
  searxng: new EngineQueue(3000),
  mojeek: new EngineQueue(3000),
  yandex: new EngineQueue(4000),
  youtube: new EngineQueue(3000),
  reference: new EngineQueue(2000),
};

async function searchHtmlEndpoint(url: string, source: string, maxResults: number, signal: AbortSignal): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  
  // Run the fetch inside the engine's specific queue
  const queue = engineQueues[source] || new EngineQueue(4000);
  return queue.run(async () => {
    try {
      const response = await fetchPage(url, signal);
      return parseSearchLinks(response.html, source, maxResults);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return [];
    }
  });
}

async function searchBrave(query: string, maxResults: number, signal: AbortSignal): Promise<ReadonlyArray<SearchHit>> {
  return searchHtmlEndpoint(`https://search.brave.com/search?q=${encodeURIComponent(query)}`, "brave", maxResults, signal);
}

async function searchGoogle(query: string, maxResults: number, signal: AbortSignal): Promise<ReadonlyArray<SearchHit>> {
  return searchHtmlEndpoint(`https://www.google.com/search?q=${encodeURIComponent(query)}&udm=14&hl=en&num=${maxResults}`, "google", maxResults, signal);
}

async function searchGoogleScholar(query: string, maxResults: number, signal: AbortSignal): Promise<ReadonlyArray<SearchHit>> {
  return searchHtmlEndpoint(`https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`, "scholar", maxResults, signal);
}

async function searchSearxng(query: string, maxResults: number, signal: AbortSignal): Promise<ReadonlyArray<SearchHit>> {
  const endpoints = [
    `https://searx.be/search?q=${encodeURIComponent(query)}&format=html`,
  ];
  for (const endpoint of endpoints) {
    const hits = await searchHtmlEndpoint(endpoint, "searxng", maxResults, signal);
    if (hits.length > 0) return hits;
  }
  return [];
}

async function searchMojeek(query: string, maxResults: number, signal: AbortSignal): Promise<ReadonlyArray<SearchHit>> {
  return searchHtmlEndpoint(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, "mojeek", maxResults, signal);
}

async function searchYandex(query: string, maxResults: number, signal: AbortSignal): Promise<ReadonlyArray<SearchHit>> {
  return searchHtmlEndpoint(`https://yandex.com/search/?text=${encodeURIComponent(query)}`, "yandex", maxResults, signal);
}

async function searchYouTube(query: string, maxResults: number, signal: AbortSignal): Promise<ReadonlyArray<SearchHit>> {
  return searchInnerTube(query, maxResults, signal);
}

// Bing HTML results embed the real target as a base64 `u=` query param inside
// https://www.bing.com/ck/a? links. Decode it to get the actual destination URL.
function decodeBingTarget(href: string): string | null {
  try {
    const url = new URL(href.replace(/&amp;/g, "&"));
    if (url.hostname !== "www.bing.com" && !url.hostname.endsWith(".bing.com")) return href.startsWith("http") ? href : null;
    const encoded = url.searchParams.get("u");
    if (!encoded) return null;
    // YouTube/Bing encodes as "a1" + base64. Strip prefix and ignore relative refs.
    const b64 = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
    if (b64.startsWith("L2")) return null; // /images/, /videos/, /maps/ internal refs
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    return decoded.startsWith("http") ? decoded : null;
  } catch {
    return null;
  }
}

async function searchBing(query: string, maxResults: number, signal: AbortSignal): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const queue = engineQueues["bing"] || new EngineQueue(4000);
  return queue.run(async () => {
    try {
      const response = await fetchPage(
        `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults, 20)}&setlang=en`,
        signal,
      );
      const hits: SearchHit[] = [];
      const seen = new Set<string>();
      // Each result is a <li class="b_algo"> block with <h2><a href target>title</a></h2>
      // plus a <p class="b_lineclamp..."> snippet.
      const algoRe = /<li class="b_algo"[\s\S]*?<\/li>/gi;
      let match: RegExpExecArray | null;
      while (hits.length < maxResults && (match = algoRe.exec(response.html)) !== null) {
        const block = match[0];
        const linkRe = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
        const lm = block.match(linkRe);
        if (!lm) continue;
        const real = decodeBingTarget(lm[1]);
        if (!real) continue;
        const title = stripHtml(lm[2]);
        const capRe = block.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
        const snippet = capRe ? stripHtml(capRe[1]) : "";
        const key = normaliseUrl(real);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        hits.push({ url: real, title, snippet, discoveredBy: "bing" });
      }
      return dedupeHits(hits, maxResults);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return [];
    }
  });
}

const INNERTUBE_SEARCH_URL = "https://www.youtube.com/youtubei/v1/search";
const INNERTUBE_WEB_CLIENT = {
  client: {
    clientName: "WEB",
    clientVersion: "2.20240814.00.00",
    hl: "en",
    gl: "US",
  },
};

function collectVideoRenderer(node: any, sink: (renderer: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (node.videoRenderer) sink(node.videoRenderer);
  for (const value of Object.values(node)) collectVideoRenderer(value, sink);
}

// YouTube's HTML results page is JS-rendered (only relative /watch?v= links that
// parseSearchLinks skips). POST to the innerTube search endpoint instead with the
// same WEB client that the web page uses — returns real video results.
async function searchInnerTube(query: string, maxResults: number, signal: AbortSignal): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const queue = engineQueues["youtube"] || new EngineQueue(3000);
  return queue.run(async () => {
    try {
      const pageRes = await fetchQueryPage("https://www.youtube.com/results?search_query=deep+learning", signal);
      if (!pageRes) return [];
      const keyMatch = pageRes.html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      if (!keyMatch) return [];
      const apiKey = keyMatch[1];

      const res = await fetch(`${INNERTUBE_SEARCH_URL}?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          ...buildBrowserHeaders(INNERTUBE_SEARCH_URL),
        },
        body: JSON.stringify({ context: INNERTUBE_WEB_CLIENT, query }),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as Record<string, any>;

      const out: SearchHit[] = [];
      const seen = new Set<string>();
      collectVideoRenderer(data, (v: any) => {
        if (out.length >= maxResults) return;
        const id = v.videoId;
        if (!id || seen.has(id)) return;
        seen.add(id);
        const title = v.title?.runs?.[0]?.text ?? "";
        const owner = v.ownerText?.runs?.[0]?.text ?? "";
        const published = v.publishedTimeText?.simpleText ?? "";
        const lengthText = v.lengthText?.simpleText ?? "";
        const desc =
          v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((r: any) => r.text ?? "").join("") ??
          v.descriptionSnippet?.runs?.map((r: any) => r.text ?? "").join("") ??
          "";
        if (!id || !title) return;
        out.push({
          url: `https://www.youtube.com/watch?v=${id}`,
          title,
          snippet: [desc, owner, published, lengthText].filter(Boolean).join(" · "),
          discoveredBy: "youtube",
        });
      });
      return dedupeHits(out, maxResults);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return [];
    }
  });
}

async function fetchQueryPage(url: string, signal: AbortSignal): Promise<{ html: string } | null> {
  try {
    const response = await fetch(url, {
      signal,
      redirect: "follow",
      headers: buildBrowserHeaders(url),
    });
    if (!response.ok) return null;
    return { html: await response.text() };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return null;
  }
}

export async function multiEngineSearch(
  query: string,
  maxResults: number,
  engines: ReadonlyArray<SearchEngine>,
  signal: AbortSignal,
  limiterFactory: LimiterFactory = () => new DdgRateLimiter(4000),
  timeRange = "all",
  options: SearchEngineOptions = {},
): Promise<ReadonlyArray<SearchHit>> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const selectedEngines = Array.from(new Set(engines.filter((engine): engine is SearchEngine => !!engine)));
  if (selectedEngines.length === 0 || maxResults <= 0) return [];

  const perEngineLimit = Math.max(1, Math.ceil(maxResults / selectedEngines.length));

  const results = await Promise.all(
    selectedEngines.map(async (engine): Promise<ReadonlyArray<SearchHit>> => {
      try {
        switch (engine) {
          case "ddg": {
            const limiter = limiterFactory();
            return searchDDG(query, perEngineLimit, "moderate", signal, limiter, timeRange);
          }
          case "bing": return searchBing(query, perEngineLimit, signal);
          case "brave": return searchBrave(query, perEngineLimit, signal);
          case "google": return searchGoogle(query, perEngineLimit, signal);
          case "scholar": return searchGoogleScholar(query, perEngineLimit, signal);
          case "searxng": return searchSearxng(query, perEngineLimit, signal);
          case "mojeek": return searchMojeek(query, perEngineLimit, signal);
          case "yandex": return searchYandex(query, perEngineLimit, signal);
          case "youtube": return searchYouTube(query, perEngineLimit, signal);
          case "serper": return options.serperApiKey ? searchSerper(query, perEngineLimit, options.serperApiKey, signal, limiterFactory()) : [];
          case "brave-api": return options.braveApiKey ? searchBraveApi(query, perEngineLimit, options.braveApiKey, signal, limiterFactory()) : [];
          case "openalex": return searchOpenAlex(query, perEngineLimit, signal);
          case "crossref": return searchCrossref(query, perEngineLimit, signal);
          case "arxiv": return searchArxiv(query, perEngineLimit, signal);
          case "gdelt": return searchGdelt(query, perEngineLimit, signal);
          case "rss":
            return options.rssFeedUrls && options.rssFeedUrls.length > 0
              ? searchRssFeeds([...options.rssFeedUrls], query, perEngineLimit, signal)
              : [];
          case "telegram":
            return options.telegramChannels && options.telegramChannels.length > 0
              ? searchTelegram([...options.telegramChannels], query, perEngineLimit, signal)
              : [];
          case "reference": return searchReferenceSites(query, perEngineLimit, signal);
          default: return [];
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        return [];
      }
    }),
  );

  return dedupeHits(results.flat(), maxResults);
}