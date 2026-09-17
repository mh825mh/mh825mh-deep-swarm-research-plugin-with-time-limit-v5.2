// src/net/search-engines.ts
import type { SearchHit } from "../types";
import { DdgRateLimiter, searchDDG } from "./ddg";
import { fetchPage } from "./http";
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
    `https://search.ononoki.org/search?q=${encodeURIComponent(query)}&format=html`,
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
  return searchHtmlEndpoint(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, "youtube", maxResults, signal);
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