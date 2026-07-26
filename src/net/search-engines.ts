import { SearchHit } from "../types";
import { buildBrowserHeaders, sleep } from "./http";
import { DdgRateLimiter } from "./ddg";

export type SearchEngine = "ddg" | "brave" | "scholar" | "searxng" | "mojeek" | "yandex";

const SEARXNG_INSTANCES: ReadonlyArray<string> = [
  "https://search.sapti.me",
  "https://searx.tiekoetter.com",
  "https://search.bus-hit.me",
  "https://priv.au",
];

const YANDEX_HOSTS: ReadonlyArray<string> = [
  "https://yandex.com",
  "https://yandex.eu",
];

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/'/g, "'")
    .replace(/'/g, "'")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseBraveResults(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const snippetBlockRe = /<div[^>]+class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*snippet|<footer)/gi;
  const linkRe = /href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const descRe = /<div[^>]+class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
  let blockMatch: RegExpExecArray | null;
  while (hits.length < maxResults && (blockMatch = snippetBlockRe.exec(html)) !== null) {
    const block = blockMatch[1];
    const lm = linkRe.exec(block);
    if (!lm) continue;
    const rawUrl = lm[1].trim();
    if (!rawUrl.startsWith("http") || seen.has(rawUrl)) continue;
    if (/brave.com|search.brave/i.test(rawUrl)) continue;
    seen.add(rawUrl);
    const title = stripTags(lm[2]).trim();
    const descMatch = descRe.exec(block);
    const snippet = descMatch ? stripTags(descMatch[1]).trim() : title;
    hits.push({ url: rawUrl, title, snippet });
  }
  if (hits.length === 0) {
    const fallbackRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*heading[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while (hits.length < maxResults && (m = fallbackRe.exec(html)) !== null) {
      const rawUrl = m[1].trim();
      if (seen.has(rawUrl) || /brave.com/i.test(rawUrl)) continue;
      seen.add(rawUrl);
      hits.push({ url: rawUrl, title: stripTags(m[2]).trim(), snippet: "" });
    }
  }
  return hits;
}

function parseScholarResults(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const blockRe = /<div[^>]+class="[^"]*gs_r[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*gs_r|$)/gi;
  const titleLinkRe = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRe = /<div[^>]+class="gs_rs"[^>]*>([\s\S]*?)<\/div>/i;
  let blockMatch: RegExpExecArray | null;
  while (hits.length < maxResults && (blockMatch = blockRe.exec(html)) !== null) {
    const block = blockMatch[1];
    const tm = titleLinkRe.exec(block);
    if (!tm) continue;
    let rawUrl = tm[1].trim();
    const urlParam = /[?&]url=(https?[^&]+)/.exec(rawUrl);
    if (urlParam) rawUrl = decodeURIComponent(urlParam[1]);
    if (!rawUrl.startsWith("http") || seen.has(rawUrl)) continue;
    if (/scholar.google|google.com\/scholar/i.test(rawUrl)) continue;
    seen.add(rawUrl);
    const title = stripTags(tm[2]).trim();
    const sm = snippetRe.exec(block);
    const snippet = sm ? stripTags(sm[1]).trim() : title;
    hits.push({ url: rawUrl, title, snippet });
  }
  return hits;
}

function parseMojeekResults(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const linkRe = /<a[^>]+class="ob"[^>]* href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<p[^>]+class="s"[^>]*>([\s\S]*?)<\/p>/gi;
  const links: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const rawUrl = m[1].trim();
    if (rawUrl.startsWith("http") && !/mojeek.com/i.test(rawUrl)) {
      links.push({ url: rawUrl, title: stripTags(m[2]).trim() });
    }
  }
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]).trim());
  }
  for (let i = 0; i < links.length && hits.length < maxResults; i++) {
    const { url, title } = links[i];
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push({ url, title, snippet: snippets[i] ?? title });
  }
  return hits;
}

function parseYandexResults(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const blockRe = /<li[^>]+class="[^"]*serp-item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  const titleLinkRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*(?:OrganicTitle-Link|Link)[^"]*"[^>]*>([\s\S]*?)<\/a>/i;
  const fallbackLinkRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRe = /<div[^>]+class="[^"]*(?:OrganicText|text-container|Text)[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
  let m: RegExpExecArray | null;
  while (hits.length < maxResults && (m = blockRe.exec(html)) !== null) {
    const block = m[1];
    const titleMatch = titleLinkRe.exec(block) ?? fallbackLinkRe.exec(block);
    if (!titleMatch) continue;
    const rawUrl = titleMatch[1].trim();
    if (!rawUrl.startsWith("http")) continue;
    if (/yandex\./i.test(rawUrl)) continue;
    if (seen.has(rawUrl)) continue;
    seen.add(rawUrl);
    const title = stripTags(titleMatch[2]).trim();
    const snippetMatch = snippetRe.exec(block);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim() : title;
    if (!title && !snippet) continue;
    hits.push({ url: rawUrl, title, snippet });
  }
  return hits;
}

export async function searchBrave(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  limiter?: DdgRateLimiter,
  _timeRange: string = "all",
): Promise<ReadonlyArray<SearchHit>> {
  if (limiter) await limiter.acquire();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
    const res = await fetch(url, {
      signal,
      headers: {
        ...buildBrowserHeaders(url),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseBraveResults(html, maxResults);
  } catch {
    return [];
  }
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
    const res = await fetch(url, { signal, headers: buildBrowserHeaders(url) });
    if (!res.ok) return [];
    const html = await res.text();
    return parseScholarResults(html, maxResults);
  } catch {
    return [];
  }
}

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
      if (!res.ok) {
        await sleep(randomBetween(120, 260));
        continue;
      }
      const data = (await res.json()) as {
        results?: Array<{ url?: string; title?: string; content?: string }>;
      };
      if (!Array.isArray(data.results)) {
        await sleep(randomBetween(120, 260));
        continue;
      }
      const hits: SearchHit[] = [];
      const seen = new Set<string>();
      for (const r of data.results) {
        if (hits.length >= maxResults) break;
        if (!r.url || !r.url.startsWith("http")) continue;
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        hits.push({
          url: r.url,
          title: (r.title ?? "").trim(),
          snippet: (r.content ?? r.title ?? "").trim(),
        });
      }
      if (hits.length > 0) return hits;
    } catch {
      await sleep(randomBetween(120, 260));
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
    const res = await fetch(url, { signal, headers: buildBrowserHeaders(url) });
    if (!res.ok) return [];
    const html = await res.text();
    return parseMojeekResults(html, maxResults);
  } catch {
    return [];
  }
}

export async function searchYandex(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  limiter?: DdgRateLimiter,
  _timeRange: string = "all",
): Promise<ReadonlyArray<SearchHit>> {
  if (limiter) await limiter.acquire();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  for (const host of YANDEX_HOSTS) {
    if (signal.aborted) break;
    try {
      const url = `${host}/search/?text=${encodeURIComponent(query)}&lr=10393`;
      const res = await fetch(url, {
        signal,
        headers: {
          ...buildBrowserHeaders(url),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      if (!res.ok) {
        await sleep(randomBetween(140, 280));
        continue;
      }
      const html = await res.text();
      const hits = parseYandexResults(html, maxResults);
      if (hits.length > 0) return hits;
    } catch {
      await sleep(randomBetween(140, 280));
      continue;
    }
  }
  return [];
}

function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function runEngine(
  engine: SearchEngine,
  query: string,
  maxResultsPerEngine: number,
  signal: AbortSignal,
  getLimiter: () => DdgRateLimiter,
  timeRange: string,
): Promise<ReadonlyArray<SearchHit>> {
  const limiter = getLimiter();
  switch (engine) {
    case "searxng":
      return searchSearXNG(query, maxResultsPerEngine, signal, limiter, timeRange);
    case "yandex":
      return searchYandex(query, maxResultsPerEngine, signal, limiter, timeRange);
    case "brave":
      return searchBrave(query, maxResultsPerEngine, signal, limiter, timeRange);
    case "scholar":
      return searchGoogleScholar(query, maxResultsPerEngine, signal, limiter);
    case "mojeek":
      return searchMojeek(query, maxResultsPerEngine, signal, limiter);
    case "ddg":
    default:
      return [];
  }
}

export async function multiEngineSearch(
  query: string,
  maxResultsPerEngine: number,
  engines: ReadonlyArray<SearchEngine>,
  signal: AbortSignal,
  getLimiter: () => DdgRateLimiter,
  timeRange: string = "all",
): Promise<ReadonlyArray<SearchHit>> {
  const ordered = Array.from(new Set(engines)).filter((e) => e !== "ddg");
  const priority: SearchEngine[] = ["yandex", "searxng", "brave", "mojeek", "scholar"];
  ordered.sort((a, b) => priority.indexOf(a) - priority.indexOf(b));

  const primary = ordered.filter((e) => e === "searxng" || e === "yandex");
  const secondary = ordered.filter((e) => e !== "searxng" && e !== "yandex");

  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  const mergeHits = (hits: ReadonlyArray<SearchHit>) => {
    for (const hit of hits) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      merged.push(hit);
    }
  };

  for (const engine of primary) {
    if (signal.aborted) break;
    try {
      const hits = await runEngine(engine, query, maxResultsPerEngine, signal, getLimiter, timeRange);
      mergeHits(hits);
    } catch {
      // ignore
    }
  }

  const enoughPrimaryCoverage = merged.length >= Math.max(8, Math.ceil(maxResultsPerEngine * 1.5));
  if (!enoughPrimaryCoverage && secondary.length > 0 && !signal.aborted) {
    const secondaryResults = await Promise.all(
      secondary.map((engine) =>
        runEngine(engine, query, maxResultsPerEngine, signal, getLimiter, timeRange).catch(() => [] as SearchHit[]),
      ),
    );
    for (const hits of secondaryResults) {
      mergeHits(hits);
    }
  }
  return merged;
}