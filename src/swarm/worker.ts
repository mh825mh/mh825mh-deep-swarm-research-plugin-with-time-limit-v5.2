// src/swarm/worker.ts
import { LlmCallManager } from "../utils/llm";
import { logLlmDiagnostics } from "../utils/tokens";
import { extractYouTubeTranscript } from "../net/youtube-extractor";
import {
  searchSerper,
  searchBraveApi,
  searchOpenAlex,
  searchCrossref,
  searchArxiv,
  searchGdelt,
  searchReferenceSites,
} from "../net/api-engines";
import {
  searchDDG,
  searchDDGPaginated,
  DdgRateLimiter,
  sharedDdgLimiter,
} from "../net/ddg";
import { multiEngineSearch, SearchEngine } from "../net/search-engines";
import { SearchHealthTracker } from "./health";
import { fetchPage, sleep } from "../net/http";
import {
  extractPage,
  contentFingerprint,
  computeRelevance,
} from "../net/extractor";
import {
  isPdfUrl,
  isPdfContentType,
  extractPdf,
} from "../net/pdf-extractor";
import {
  scoreCandidate,
  rankCandidates,
  scoreOutlinks,
} from "../scoring/authority";
import {
  SwarmTask,
  WorkerResult,
  CrawledSource,
  ScoredCandidate,
  SourceTier,
  StatusFn,
  WarnFn,
  SearchHit,
  ExtractedPage,
} from "../types";
import { harvestLocalSources } from "../local/search";
import {
  BATCH_INTER_FETCH_DELAY_MS,
  MIN_USEFUL_WORD_COUNT,
} from "../constants";
import { normalizeUrl } from "./visited-cache";

export interface CrawlMetrics {
  ddgQueries: number;
  ddgHits: number;
  mutatedQueriesTried: number;
  mutationAccepted: number;
  mutationHits: number;
  extraEngineQueries: number;
  extraEngineHits: number;
  rawHits: number;
  dedupedHits: number;
  rankedCandidates: number;
  fetchCandidates: number;
  fetchAttempts: number;
  fetchFailures: number;
  acceptedSources: number;
  skippedLowWordCount: number;
  skippedOffTopic: number;
  skippedVeryOffTopic: number;
  skippedDuplicateContent: number;
  skippedVisited: number;
  skippedDomainCap: number;
  skippedAvoided: number;
  skippedBlacklisted: number;
  cacheChecks: number;
  cacheHits: number;
  cacheAccepted: number;
  cacheRejectedDuplicate: number;
  cacheRejectedOffTopic: number;
  cacheRejectedLowWordCount: number;
  cacheWrites: number;
  followedLinks: number;
  crossWorkerDiscoveriesUsed: number;
  localSourcesAccepted: number;
}

export interface SharedCrawlState {
  readonly visitedUrls: ReadonlySet<string>;
  readonly contentHashes: ReadonlySet<string>;
  readonly domainCounts: ReadonlyMap<string, number>;
  readonly domainFailures: ReadonlyMap<string, number>;
  addVisited(url: string): void;
  addHash(hash: string): void;
  incrementDomain(url: string): void;
  domainCount(url: string): number;
  noteFailure(url: string, reason: string): void;
  noteDomainFailure(url: string): void;
  isDomainBlacklisted(url: string): boolean;
  shouldAvoidUrl(url: string): boolean;
  pushDiscovery(url: string, title: string, fromWorker: string): void;
  drainDiscoveries(limit: number): ReadonlyArray<{ url: string; title: string }>;
  isRecentlyVisited(url: string): boolean;
  getCachedSource(url: string): CrawledSource | null;
  markVisitedPersistent(source: CrawledSource): void;
  addWebCacheDocument(source: CrawledSource): void;
  getMetricsSnapshot(): Readonly<CrawlMetrics>;
  mergeMetrics(delta: Partial<CrawlMetrics>): void;
}

const MUTATION_STRATEGIES: ReadonlyArray<(q: string) => string> = [
  (q) => `"${q}"`,
  (q) => `${q} explained`,
  (q) => `${q} guide overview`,
  (q) => `${q} research`,
  (q) => q.split(" ").slice(0, 10).join(" "),
  (q) => q.replace(/\b(how|what|why|when)\b/gi, " ").trim(),
];

type SearchHitLike = {
  url: string;
  title: string;
  snippet: string;
  query: string;
  discoveredBy?: string;
  requestedRoute?: string; // <--- ADD THIS
  actualBackend?: string;  // <--- ADD THIS
  resultDomain?: string;   // <--- ADD THIS
};

function isRateLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit")
  );
}

function zeroMetrics(): CrawlMetrics {
  return {
    ddgQueries: 0, ddgHits: 0, mutatedQueriesTried: 0, mutationAccepted: 0,
    mutationHits: 0, extraEngineQueries: 0, extraEngineHits: 0, rawHits: 0,
    dedupedHits: 0, rankedCandidates: 0, fetchCandidates: 0, fetchAttempts: 0,
    fetchFailures: 0, acceptedSources: 0, skippedLowWordCount: 0, skippedOffTopic: 0,
    skippedVeryOffTopic: 0, skippedDuplicateContent: 0, skippedVisited: 0, skippedDomainCap: 0,
    skippedAvoided: 0, skippedBlacklisted: 0, cacheChecks: 0, cacheHits: 0, cacheAccepted: 0,
    cacheRejectedDuplicate: 0, cacheRejectedOffTopic: 0, cacheRejectedLowWordCount: 0,
    cacheWrites: 0, followedLinks: 0, crossWorkerDiscoveriesUsed: 0, localSourcesAccepted: 0,
  };
}

export async function runWorker(
  task: SwarmTask,
  state: SharedCrawlState,
  signal: AbortSignal,
  status: StatusFn,
  warn: WarnFn,
  topicKws: ReadonlyArray<string> = [],
  limiter: DdgRateLimiter = sharedDdgLimiter,
  health: SearchHealthTracker,
  llmManager: LlmCallManager
): Promise<WorkerResult> {
  const sources: CrawledSource[] = [];
  const errors: string[] = [];
  const queriesExecuted: string[] = [];
  const roleTag = `[${task.label}]`;
  const metrics = zeroMetrics();

  status(`${roleTag} Starting - ${task.queries.length} queries, budget=${task.pageBudget}, links=${task.followLinks ? "on" : "off"}`);

  if (task.enableLocalSources) {
    const localBudget = Math.max(2, Math.ceil(task.pageBudget * 0.3));
    const localSources = harvestLocalSources(
      task.queries, task.role, task.label, localBudget, task.contentLimit, task.localLibraryIds, task.roleLibraryMap,
    );

    if (localSources.length > 0) {
      for (const src of localSources) {
        state.addVisited(src.url);
        state.addHash(contentFingerprint(src.text));
        sources.push(src);
      }
      metrics.localSourcesAccepted += localSources.length;
      status(`${roleTag} Local sources: ${localSources.length} chunks`);
    }
  }

  const allHits: SearchHitLike[] = [];
  let ddgBlocked = false;

  for (const query of task.queries) {
    if (signal.aborted) break;

    // 9. QUERY PLANNING RULES - Reject bad queries
    const qLower = query.toLowerCase();
    if (qLower.includes("definition and overview") || qLower.includes("how does") || qLower.includes("what is") || qLower.length > 100) {
      warn(`[Query Quality] Rejected invalid query template: "${query}"`);
      continue;
    }

    let ddgHits: ReadonlyArray<SearchHit> = [];
    let effectiveHitCount = 0;

        // 4. DDG FAILURE DEFINITION & HEALTH TRACKING
    if (task.extraEngines.includes("ddg") && health.isDdgAvailable()) {
      metrics.ddgQueries++;
      try {
        if (task.searchPages > 1) {
          ddgHits = await searchDDGPaginated(query, task.searchResultsPerQuery, task.searchPages, task.safeSearch, signal, limiter, task.timeRange ?? "all");
        } else {
          ddgHits = await searchDDG(query, task.searchResultsPerQuery, task.safeSearch, signal, limiter, task.timeRange ?? "all");
        }

        // 5. Make DDG health deterministic: Require >= 3 unique non-blocked results
        if (ddgHits.length < 3) {
          throw new Error("INVALID_RESULT_SET (< 3 results)");
        }

        health.recordDdgSuccess(ddgHits.length);
        metrics.ddgHits += ddgHits.length;
        effectiveHitCount = ddgHits.length;

        // Track Attribution
        for (const h of ddgHits) {
          let domain = "";
          try { domain = new URL(h.url).hostname.replace(/^www\./, ""); } catch {}
          allHits.push({ 
            ...h, 
            query, 
            requestedRoute: "DDG",
            actualBackend: "DDG",
            resultDomain: domain
          });
        }
        
        queriesExecuted.push(query);
        status(`${roleTag} DDG: "${query}" -> ${ddgHits.length} results`);
      } catch (err: unknown) {
        if (isAbortError(err)) break;
        const msg = errorMessage(err);
        health.recordDdgFailure(msg);
        warn(`${roleTag} DDG failed (${health.ddg.consecutiveFailures}/5): ${msg}`);
      }
    }

    // Query Mutation (LLM)
    if (
      ddgHits.length < task.queryMutationThreshold &&
      !signal.aborted &&
      !ddgBlocked &&
      llmManager.canCall(task.id)
    ) {
      llmManager.recordCall(task.id);
      
      const contextSnippets = allHits.filter((h) => h.query === query).slice(0, 3).map((h) => h.snippet);
      const llmMutated = await getLLMQueryMutation(query, contextSnippets, signal);
      
      const mutationsToTry = [llmMutated, ...MUTATION_STRATEGIES.map((s) => s(query))].filter((m): m is string => !!m && m !== query);
      let bestMutation: { query: string; hits: ReadonlyArray<SearchHit> } | null = null;
      const baseline = mutationQuality(ddgHits);

      for (const mutated of mutationsToTry) {
        if (signal.aborted) break;
        metrics.mutatedQueriesTried++;
        metrics.ddgQueries++;

        try {
          const mutHits = await searchDDG(mutated, task.searchResultsPerQuery, task.safeSearch, signal, limiter, task.timeRange ?? "all");
          metrics.ddgHits += mutHits.length;

          if (mutationQuality(mutHits) > baseline) {
            if (!bestMutation || mutationQuality(mutHits) > mutationQuality(bestMutation.hits)) {
              bestMutation = { query: mutated, hits: mutHits };
            }
          }
        } catch (err) {
          const msg = errorMessage(err);
          if (isRateLimitError(msg)) {
            ddgBlocked = true;
            warn(`${roleTag} Mutation RATE LIMIT (429)! Falling back...`);
            break;
          }
        }
      }

      if (bestMutation) {
        metrics.mutationAccepted++;
        metrics.mutationHits += bestMutation.hits.length;
        for (const h of bestMutation.hits) allHits.push({ ...h, query: bestMutation.query });
        queriesExecuted.push(bestMutation.query);
        effectiveHitCount = Math.max(effectiveHitCount, bestMutation.hits.length);
      }
    } else if (llmManager.canCall(task.id) === false) {
      warn(`${roleTag} LLM call budget exhausted, skipping mutation.`);
    }

    // Fallback to SearxNG or API if DDG is dead or hit 0
    const shouldUseExtraEngines = task.extraEngines.length > 0 && !signal.aborted && (ddgBlocked || effectiveHitCount < Math.ceil(task.searchResultsPerQuery * 0.6) || task.role === "academic" || task.role === "primary" || task.role === "regulatory");

    if (shouldUseExtraEngines) {
      metrics.extraEngineQueries++;
      try {
        const extraHits = await multiEngineSearch(
          query, Math.min(task.searchResultsPerQuery, 8),
          task.extraEngines as ReadonlyArray<SearchEngine>,
          signal, () => limiter, task.timeRange ?? "all",
          { serperApiKey: (task as any).serperApiKey, braveApiKey: (task as any).braveApiKey }
        );
        metrics.extraEngineHits += extraHits.length;
        for (const h of extraHits) allHits.push({ ...h, query });
        if (extraHits.length > 0) status(`${roleTag} -> ${extraHits.length} extra results`);
      } catch {}
    }
  }

  metrics.rawHits = allHits.length;

  if (signal.aborted || allHits.length === 0) {
    metrics.acceptedSources = sources.length;
    state.mergeMetrics(metrics);
    return { taskId: task.id, role: task.role, label: task.label, sources, queries: queriesExecuted, errors };
  }

  const deduped = deduplicateByUrl(allHits);
  metrics.dedupedHits = deduped.length;

  const scored = deduped.map((h) => {
    const sc = scoreCandidate(h, h.query);
    return { ...sc, discoveredBy: h.discoveredBy };
  });
  
  const filtered = task.preferredTiers ? scored.filter((c) => task.preferredTiers!.includes(c.tier)) : scored;
  const poolSize = task.pageBudget * task.candidatePoolMultiplier;
  const ranked = rankCandidates(filtered.length > 0 ? filtered : scored, poolSize);
  const candidates = capCandidatesPerHost(ranked, 2);

  metrics.rankedCandidates = candidates.length;
  metrics.fetchCandidates = candidates.length;

  await fetchBatch(candidates, task, state, signal, status, warn, sources, errors, roleTag, topicKws, metrics, llmManager);
  
  if (task.followLinks && sources.length > 0 && sources.length < task.pageBudget) {
    for (let depth = 1; depth <= task.linkCrawlDepth; depth++) {
      if (sources.length >= task.pageBudget || signal.aborted) break;
      const budget = Math.min(task.pageBudget - sources.length, task.maxLinksToFollow);
      if (budget <= 0) break;

      const sourcesForLinks = depth === 1 ? sources : sources.slice(-budget * 2);
      const newCount = await followLinks(sourcesForLinks, task, state, signal, status, warn, sources, errors, roleTag, budget, topicKws, depth, metrics, llmManager);
      metrics.followedLinks += newCount;
      if (newCount === 0) break;
    }
  }

  for (const src of sources) {
    for (const link of src.outlinks.slice(0, 5)) {
      state.pushDiscovery(link.href, link.text, task.label);
    }
  }

  metrics.acceptedSources = sources.length;
  state.mergeMetrics(metrics);
  status(`✅ ${roleTag} Mission Complete - ${sources.length} high-quality sources collected!`);

  return { taskId: task.id, role: task.role, label: task.label, sources, queries: queriesExecuted, errors };
}

async function fetchBatch(
  candidates: ReadonlyArray<ScoredCandidate>,
  task: SwarmTask,
  state: SharedCrawlState,
  signal: AbortSignal,
  status: StatusFn,
  warn: WarnFn,
  results: CrawledSource[],
  errors: string[],
  tag: string,
  topicKws: ReadonlyArray<string>,
  metrics: CrawlMetrics,
  llmManager: LlmCallManager
): Promise<void> {
  let idx = 0;
  const concurrency = task.workerConcurrency;
  const domainCap = task.maxPagesPerDomain;
  const minRelevance = task.minRelevanceScore;

  while (results.length < task.pageBudget && idx < candidates.length && !signal.aborted) {
    const slice = candidates.slice(idx, idx + concurrency);
    idx += concurrency;

    const batch: ScoredCandidate[] = [];
    for (const c of slice) {
      const normalized = normalizeUrl(c.url);
      if (state.visitedUrls.has(normalized)) { metrics.skippedVisited++; continue; }
      if (state.domainCount(c.url) >= domainCap) { metrics.skippedDomainCap++; continue; }
      if (state.shouldAvoidUrl(c.url)) { metrics.skippedAvoided++; continue; }
      if (state.isDomainBlacklisted(c.url)) { metrics.skippedBlacklisted++; continue; }
      batch.push(c);
    }

    if (batch.length === 0) continue;

    for (const c of batch) state.addVisited(c.url);

    const settled = await Promise.allSettled(
      batch.map((c) => resolveCandidate(c, task, state, topicKws, signal, metrics)),
    );

    for (let i = 0; i < settled.length; i++) {
      const candidate = batch[i];
      const settledResult = settled[i];

      if (signal.aborted) return;

      if (settledResult.status === "rejected") {
        if (!isAbortError(settledResult.reason)) {
          const msg = errorMessage(settledResult.reason);
          metrics.fetchFailures++;
          state.noteFailure(candidate.url, msg);
          state.noteDomainFailure(candidate.url);
          warn(`${tag} Failed: ${truncUrl(candidate.url)} - ${msg}`);
          errors.push(`fetch:${candidate.url}: ${msg}`);
        }
        continue;
      }

      const { page, fromCache } = settledResult.value;

      if (page.wordCount < MIN_USEFUL_WORD_COUNT) { metrics.skippedLowWordCount++; if (fromCache) metrics.cacheRejectedLowWordCount++; continue; }
      if (page.relevanceScore < minRelevance * 0.5) { metrics.skippedVeryOffTopic++; if (fromCache) metrics.cacheRejectedOffTopic++; else state.noteDomainFailure(candidate.url); continue; }
      if (page.relevanceScore < minRelevance) { metrics.skippedOffTopic++; if (fromCache) metrics.cacheRejectedOffTopic++; continue; }

      const fp = contentFingerprint(page.text);
      if (state.contentHashes.has(fp)) { metrics.skippedDuplicateContent++; if (fromCache) metrics.cacheRejectedDuplicate++; continue; }

      state.addHash(fp);
      state.incrementDomain(candidate.url);

      if (fromCache) {
        metrics.cacheAccepted++;
      } else {
        state.markVisitedPersistent(page);
        metrics.cacheWrites++;
        state.addWebCacheDocument(page);
      }

      results.push(page);
      llmManager.recordProgress(); // Tell the watchdog we found something!

      status(`${tag} [${results.length}/${task.pageBudget}] ${fromCache ? "[cache] " : ""}(rel=${page.relevanceScore.toFixed(2)}) ${page.title.slice(0, 60)}`);

      if (results.length >= task.pageBudget) return;
    }

    if (idx < candidates.length && results.length < task.pageBudget) {
      await sleep(BATCH_INTER_FETCH_DELAY_MS);
    }
  }
}

async function resolveCandidate(
  candidate: ScoredCandidate,
  task: SwarmTask,
  state: SharedCrawlState,
  topicKws: ReadonlyArray<string>,
  signal: AbortSignal,
  metrics: CrawlMetrics,
): Promise<{ page: CrawledSource; fromCache: boolean }> {
  metrics.cacheChecks++;

  const cached = state.getCachedSource(candidate.url);
  if (cached) {
    metrics.cacheHits++;
    return {
      page: adaptCachedSourceForTask(cached, candidate.query, candidate.snippet, task, topicKws),
      fromCache: true,
    };
  }

  metrics.fetchAttempts++;
  return {
    page: await fetchAndExtract(candidate.url, candidate.query, candidate.snippet, task, topicKws, signal, candidate.discoveredBy),
    fromCache: false,
  };
}

function adaptCachedSourceForTask(
  cached: CrawledSource,
  query: string,
  snippet: string,
  task: SwarmTask,
  topicKws: ReadonlyArray<string>,
): CrawledSource {
  const { domainScore, freshnessScore, tier } = scoreCandidate({ url: cached.url, title: cached.title, snippet: cached.description }, query);
  const relevanceScore = computeRelevance(cached.text, cached.title, snippet, topicKws);
  return {
    ...cached,
    url: normalizeUrl(cached.url),
    finalUrl: normalizeUrl(cached.finalUrl ?? cached.url),
    sourceQuery: query,
    workerRole: task.role,
    workerLabel: task.label,
    domainScore,
    freshnessScore,
    tier: tier as SourceTier,
    relevanceScore,
  };
}

async function followLinks(
  existingSources: ReadonlyArray<CrawledSource>,
  task: SwarmTask,
  state: SharedCrawlState,
  signal: AbortSignal,
  status: StatusFn,
  warn: WarnFn,
  results: CrawledSource[],
  errors: string[],
  tag: string,
  budget: number,
  topicKws: ReadonlyArray<string>,
  depth: number,
  metrics: CrawlMetrics,
  llmManager: LlmCallManager
): Promise<number> {
  const allLinks = existingSources.flatMap((s) => s.outlinks);
  const linkKws = task.queries.join(" ").toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 12);

  const scored = scoreOutlinks(allLinks, linkKws, state.visitedUrls, task.maxLinksToEvaluate);
  const toFollow = scored.slice(0, task.maxLinksToFollow);

  if (toFollow.length === 0) return 0;

  status(`${tag} Following ${toFollow.length} link(s) (depth ${depth})…`);

  const before = results.length;
  const linkCandidates = toFollow.map((l) => scoreCandidate({ url: l.href, title: "", snippet: "" }, task.queries[0] ?? ""));

  await fetchBatch(linkCandidates, { ...task, pageBudget: results.length + budget }, state, signal, status, warn, results, errors, tag, topicKws, metrics, llmManager);

  return results.length - before;
}

async function fetchAndExtract(
  url: string,
  query: string,
  snippet: string,
  task: SwarmTask,
  topicKws: ReadonlyArray<string>,
  signal: AbortSignal,
  discoveredBy?: string,
): Promise<CrawledSource> {
  let page: ExtractedPage;

  if (/youtube\.com|youtu\.be/i.test(url)) {
    const ytData = await extractYouTubeTranscript(url, signal, task.contentLimit);
    if (!ytData) throw new Error("YouTube transcript extraction failed");
    page = {
      url: url,
      finalUrl: url,
      title: ytData.title,
      description: ytData.description,
      published: null,
      text: ytData.text,
      wordCount: ytData.text.split(/\s+/).filter(Boolean).length,
      outlinks: [],
      page: 1,
      totalPages: 1,
    };
  } else {
    const fetchResult = await fetchWithWaybackFallback(url, signal, task);
    const { finalUrl } = fetchResult;

    const isPdf = (fetchResult.rawBuffer && isPdfContentType(fetchResult.contentType)) || (!fetchResult.rawBuffer && isPdfUrl(url));

    if (isPdf && fetchResult.rawBuffer) {
      page = await extractPdf(fetchResult.rawBuffer, url, finalUrl, task.contentLimit, false);
    } else if (isPdf && fetchResult.html && fetchResult.html.startsWith("%PDF")) {
      const buf = Buffer.from(fetchResult.html, "binary");
      page = await extractPdf(buf, url, finalUrl, task.contentLimit, false);
    } else {
      page = extractPage(fetchResult.html, url, finalUrl, task.contentLimit, task.maxOutlinksPerPage);
    }
  }

  const { domainScore, freshnessScore, tier } = scoreCandidate({ url, title: page.title, snippet: page.description }, query);
  const relevanceScore = computeRelevance(page.text, page.title, snippet, topicKws);

  return {
    url: normalizeUrl(page.url),
    finalUrl: normalizeUrl(page.finalUrl),
    title: page.title,
    description: page.description,
    published: page.published,
    text: page.text,
    wordCount: page.wordCount,
    outlinks: page.outlinks,
    sourceQuery: query,
    workerRole: task.role,
    workerLabel: task.label,
    domainScore,
    freshnessScore,
    tier: tier as SourceTier,
    relevanceScore,
    origin: "web" as const,
    discoveredBy: discoveredBy ?? "unknown",
    page: page.page,
    totalPages: page.totalPages,
  };
}

async function getLLMQueryMutation(
  query: string,
  topSnippets: string[],
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const endpoint = "http://localhost:1234/v1/chat/completions";
    const prompt = `You are a deep research assistant. The initial query "${query}" yielded these snippets:\n${topSnippets.slice(0, 3).join("\n")}\n\nGenerate ONE highly specific, alternative search query to find missing technical details or counter-arguments. Return ONLY the raw query string, no quotes or explanations.`;
    
    logLlmDiagnostics("getLLMQueryMutation", prompt);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: "local-model",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 40,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const mutated = data.choices?.[0]?.message?.content?.trim();
    return mutated ? mutated.replace(/^[\"']|[\"']$/g, "") : null;
  } catch {
    return null;
  }
}

async function fetchWithWaybackFallback(
  url: string,
  signal: AbortSignal,
  task: SwarmTask // <-- We add task here to grab the config!
): Promise<Awaited<ReturnType<typeof fetchPage>>> {
  try {
    // TIER A: Standard Fetch (Tries normally first)
    return await fetchPage(url, signal);
  } catch (err: any) {
    if (isAbortError(err)) throw err;

    // TIER B: FlareSolverr (Optional Power-User Bypass)
    const fsUrl = (task as any).flaresolverrUrl as string | undefined;
    if (fsUrl && fsUrl.trim() !== "") {
      try {
        const fsRes = await fetch(fsUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cmd: "request.get", url: url, maxTimeout: 15000 }),
          signal
        });
        const fsData = await fsRes.json();
        if (fsData?.solution?.response) {
          return {
            html: fsData.solution.response,
            finalUrl: url,
            contentType: "text/html",
            rawBuffer: undefined // FlareSolverr only returns HTML, not raw PDFs
          };
        }
      } catch (fsErr) {
        // Silently fail and drop down to Wayback Machine
      }
    }

    // TIER C: Wayback Machine Archive
    try {
      const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
      const apiRes = await fetch(api, { signal });
      if (!apiRes.ok) throw new Error("Wayback API failed");
      const data = await apiRes.json();
      const wbUrl = data?.archived_snapshots?.closest?.url;
      if (wbUrl) {
        return await fetchPage(wbUrl, signal);
      }
    } catch {
      // ignore
    }
    throw err;
  }
}

function uniqueHostCount(hits: ReadonlyArray<{ url: string }>): number {
  const hosts = new Set<string>();
  for (const h of hits) {
    try {
      hosts.add(new URL(h.url).hostname.replace(/^www\./, ""));
    } catch {
      // ignore
    }
  }
  return hosts.size;
}

function mutationQuality(hits: ReadonlyArray<{ url: string }>): number {
  return uniqueHostCount(hits) * 10 + Math.min(hits.length, 10);
}

function deduplicateByUrl<T extends { url: string }>(items: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = normalizeUrl(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function capCandidatesPerHost(
  candidates: ReadonlyArray<ScoredCandidate>,
  maxPerHost: number,
): ScoredCandidate[] {
  const perHost = new Map<string, number>();
  const kept: ScoredCandidate[] = [];

  for (const c of candidates) {
    const host = safeHostname(c.url);
    const count = perHost.get(host) ?? 0;
    if (count >= maxPerHost) continue;
    perHost.set(host, count + 1);
    kept.push(c);
  }

  return kept;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function truncUrl(url: string, max = 70): string {
  return url.length > max ? url.slice(0, max) + "…" : url;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown");
}