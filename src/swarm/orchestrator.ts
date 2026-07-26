import { runWorker, SharedCrawlState, CrawlMetrics } from "./worker";
import {
  buildQueryPlan,
  buildAdaptiveGapFill,
  summariseFindings,
} from "../planning/planner";
import { detectCoveredDimensions, DIMENSIONS } from "../planning/dimensions";
import {
  ResearchConfig,
  SwarmTask,
  WorkerResult,
  CrawledSource,
  WorkerRole,
  AgentMessage,
  StatusFn,
  WarnFn,
  SourceTier,
} from "../types";
import { DepthProfile } from "../constants";
import { DdgLimiterPool, resetThrottle } from "../net/ddg";
import { VisitedPageCache, normalizeUrl } from "./visited-cache";
import { log } from "./logger";

type GapPlanLike = {
  readonly role: WorkerRole;
  readonly label: string;
  readonly queries: ReadonlyArray<string>;
  readonly followLinks: boolean;
  readonly preferredTiers?: ReadonlyArray<SourceTier>;
};

function zeroMetrics(): CrawlMetrics {
  return {
    ddgQueries: 0, ddgHits: 0, mutatedQueriesTried: 0, mutationAccepted: 0,
    mutationHits: 0, extraEngineQueries: 0, extraEngineHits: 0, rawHits: 0,
    dedupedHits: 0, rankedCandidates: 0, fetchCandidates: 0, fetchAttempts: 0,
    fetchFailures: 0, acceptedSources: 0, skippedLowWordCount: 0, skippedOffTopic: 0,
    skippedVeryOffTopic: 0, skippedDuplicateContent: 0, skippedVisited: 0,
    skippedDomainCap: 0, skippedAvoided: 0, skippedBlacklisted: 0, cacheChecks: 0,
    cacheHits: 0, cacheAccepted: 0, cacheRejectedDuplicate: 0, cacheRejectedOffTopic: 0,
    cacheRejectedLowWordCount: 0, cacheWrites: 0, followedLinks: 0,
    crossWorkerDiscoveriesUsed: 0, localSourcesAccepted: 0,
  };
}

function mergeMetricObjects(base: CrawlMetrics, delta: Partial<CrawlMetrics>): CrawlMetrics {
  const next = { ...base };
  for (const key of Object.keys(next) as Array<keyof CrawlMetrics>) {
    next[key] = (next[key] ?? 0) + (delta[key] ?? 0);
  }
  return next;
}

function formatProgressBar(current: number, total: number, width: number = 20): string {
  if (total <= 0) return `[${"░".repeat(width)}] 0%`;
  const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  const filled = Math.round((pct / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${pct}%`;
}

class MutableCrawlState implements SharedCrawlState {
  private readonly _visitedUrls = new Set<string>();
  private readonly _contentHashes = new Set<string>();
  private readonly _domainCounts = new Map<string, number>();
  private readonly _domainFailures = new Map<string, number>();
  private readonly _blacklistedDomains = new Set<string>();
  private readonly _discoveries: Array<{ url: string; title: string; fromWorker: string }> = [];
  private readonly _failedUrls = new Map<string, { count: number; reason: string; lastFailedAt: string }>();
  private readonly _failedHosts = new Map<string, { count: number; reason: string; lastFailedAt: string }>();
  private readonly visitedCache = new VisitedPageCache();
  private _metrics: CrawlMetrics = zeroMetrics();

  get visitedUrls(): ReadonlySet<string> { return this._visitedUrls; }
  get contentHashes(): ReadonlySet<string> { return this._contentHashes; }
  get domainCounts(): ReadonlyMap<string, number> { return this._domainCounts; }
  get domainFailures(): ReadonlyMap<string, number> { return this._domainFailures; }

  addVisited(url: string): void { this._visitedUrls.add(normalizeUrl(url)); }
  addHash(hash: string): void { this._contentHashes.add(hash); }
  incrementDomain(url: string): void {
    const host = safeHostname(url);
    if (!host) return;
    this._domainCounts.set(host, (this._domainCounts.get(host) ?? 0) + 1);
  }
  domainCount(url: string): number {
    const host = safeHostname(url);
    return host ? (this._domainCounts.get(host) ?? 0) : 0;
  }

  noteFailure(url: string, reason: string, at: string = new Date().toISOString()): void {
    const normalized = normalizeUrl(url);
    const prevUrl = this._failedUrls.get(normalized);
    this._failedUrls.set(normalized, { count: (prevUrl?.count ?? 0) + 1, reason, lastFailedAt: at });
    const host = safeHostname(normalized);
    if (!host) return;
    const prevHost = this._failedHosts.get(host);
    this._failedHosts.set(host, { count: (prevHost?.count ?? 0) + 1, reason, lastFailedAt: at });
  }

  noteDomainFailure(url: string): void {
    const host = safeHostname(url);
    if (!host) return;
    const count = (this._domainFailures.get(host) ?? 0) + 1;
    this._domainFailures.set(host, count);
    if (count >= 3) this._blacklistedDomains.add(host);
  }

  isDomainBlacklisted(url: string): boolean {
    const host = safeHostname(url);
    return host ? this._blacklistedDomains.has(host) : false;
  }

  shouldAvoidUrl(url: string): boolean {
    const normalized = normalizeUrl(url);
    if (this._failedUrls.has(normalized)) return true;
    const host = safeHostname(normalized);
    if (!host) return false;
    const hostFailCount = this._failedHosts.get(host)?.count ?? 0;
    return hostFailCount >= 2;
  }

  pushDiscovery(url: string, title: string, fromWorker: string): void {
    const normalized = normalizeUrl(url);
    if (!this._visitedUrls.has(normalized)) {
      this._discoveries.push({ url: normalized, title, fromWorker });
    }
  }

  drainDiscoveries(limit: number): ReadonlyArray<{ url: string; title: string }> {
    const results: Array<{ url: string; title: string }> = [];
    while (results.length < limit && this._discoveries.length > 0) {
      const item = this._discoveries.shift()!;
      if (!this._visitedUrls.has(normalizeUrl(item.url))) {
        results.push({ url: item.url, title: item.title });
      }
    }
    return results;
  }

  isRecentlyVisited(url: string): boolean { return this.visitedCache.hasRecent(url); }
  getCachedSource(url: string): CrawledSource | null { return this.visitedCache.getRecent(url); }
  markVisitedPersistent(source: CrawledSource): void { this.visitedCache.markVisited(source); }
  pruneVisitedCache(): void { this.visitedCache.prune(); }
  cacheStats(): { entries: number; file: string; maxAgeDays: number } { return this.visitedCache.stats(); }
  getMetricsSnapshot(): Readonly<CrawlMetrics> { return this._metrics; }
  mergeMetrics(delta: Partial<CrawlMetrics>): void { this._metrics = mergeMetricObjects(this._metrics, delta); }
}

const CORE_ROLES: ReadonlyArray<WorkerRole> = ["breadth", "depth", "recency", "academic", "critical"];
const EXTENDED_ROLES: ReadonlyArray<WorkerRole> = ["statistical", "regulatory", "technical", "primary", "comparative"];
const ROLE_LABELS: Readonly<Record<WorkerRole, string>> = {
  breadth: "Breadth", depth: "Depth", recency: "Recency", academic: "Academic", critical: "Critical",
  statistical: "Statistical/Data", regulatory: "Regulatory/Policy", technical: "Technical Deep-Dive",
  primary: "Primary Sources", comparative: "Comparative Analysis",
};

function rolesForProfile(profile: DepthProfile): ReadonlyArray<WorkerRole> {
  if (profile.depthRounds >= 10) return [...CORE_ROLES, ...EXTENDED_ROLES];
  if (profile.depthRounds >= 5) return [...CORE_ROLES, "technical", "comparative", "statistical"];
  return [...CORE_ROLES];
}

function buildTaskBase(
  profile: DepthProfile,
  cfg: ResearchConfig,
): Pick<SwarmTask,
  | "contentLimit"
  | "safeSearch"
  | "searchResultsPerQuery"
  | "maxPagesPerDomain"
  | "maxLinksToEvaluate"
  | "maxLinksToFollow"
  | "candidatePoolMultiplier"
  | "workerConcurrency"
  | "minRelevanceScore"
  | "maxOutlinksPerPage"
  | "searchPages"
  | "extraEngines"
  | "linkCrawlDepth"
  | "queryMutationThreshold"
  | "enableLocalSources"
  | "localLibraryIds"
  | "roleLibraryMap"
> {
  return {
    contentLimit: cfg.contentLimitPerPage,
    safeSearch: cfg.safeSearch,
    searchResultsPerQuery: profile.searchResultsPerQuery,
    maxPagesPerDomain: profile.maxPagesPerDomain,
    maxLinksToEvaluate: profile.maxLinksToEvaluate,
    maxLinksToFollow: profile.maxLinksToFollow,
    candidatePoolMultiplier: profile.candidatePoolMultiplier,
    workerConcurrency: profile.workerConcurrency,
    minRelevanceScore: profile.minRelevanceScore,
    maxOutlinksPerPage: profile.maxOutlinksPerPage,
    searchPages: profile.searchPages,
    extraEngines: profile.extraEngines,
    linkCrawlDepth: profile.linkCrawlDepth,
    queryMutationThreshold: profile.queryMutationThreshold,
    enableLocalSources: cfg.enableLocalSources,
    localLibraryIds: cfg.localLibraryIds,
    roleLibraryMap: cfg.roleLibraryMap,
  };
}

function buildStaticTask(
  role: WorkerRole,
  queries: ReadonlyArray<string>,
  profile: DepthProfile,
  cfg: ResearchConfig,
  subIdx: number = 0,
): SwarmTask {
  const followRoles: ReadonlyArray<WorkerRole> = ["depth", "academic", "technical", "primary"];
  const academicTiers: ReadonlyArray<SourceTier> = ["academic", "government", "reference"];
  return {
    ...buildTaskBase(profile, cfg),
    id: `${role}-s${subIdx}-${Date.now()}`,
    role,
    label: subIdx > 0 ? `${ROLE_LABELS[role]} #${subIdx + 1}` : ROLE_LABELS[role],
    queries: [...queries],
    pageBudget: profile.pageBudgetPerWorker,
    followLinks: cfg.enableLinkFollowing && followRoles.includes(role),
    preferredTiers: role === "academic" || role === "regulatory" ? academicTiers : undefined,
  };
}

function fanOutQueries(
  queries: ReadonlyArray<string>,
  fanOut: number,
): ReadonlyArray<ReadonlyArray<string>> {
  if (fanOut <= 1 || queries.length <= 2) return [queries];
  const groups: string[][] = Array.from({ length: fanOut }, () => []);
  for (let i = 0; i < queries.length; i++) {
    groups[i % fanOut].push(queries[i]);
  }
  return groups.filter((g) => g.length > 0);
}

function buildRound1Tasks(
  roles: ReadonlyArray<WorkerRole>,
  queriesByRole: Partial<Record<WorkerRole, ReadonlyArray<string>>>,
  profile: DepthProfile,
  cfg: ResearchConfig,
): SwarmTask[] {
  const allQueries = Array.from(
    new Set(
      Object.values(queriesByRole)
        .flatMap((qs) => qs ?? [])
        .filter((q): q is string => Boolean(q)),
    ),
  );
  const round1Tasks: SwarmTask[] = [];
  for (const role of roles) {
    const roleQueries = (queriesByRole[role] ?? []).filter(Boolean);
    const effectiveQueries = roleQueries.length > 0 ? roleQueries : allQueries;
    const groups = fanOutQueries(effectiveQueries, profile.workerFanOut);
    for (const [subIdx, group] of groups.entries()) {
      if (group.length > 0) {
        round1Tasks.push(buildStaticTask(role, group, profile, cfg, subIdx));
      }
    }
  }
  return round1Tasks;
}

function buildGapTasks(
  gapPlans: ReadonlyArray<GapPlanLike>,
  round: number,
  profile: DepthProfile,
  cfg: ResearchConfig,
): SwarmTask[] {
  const tasks: SwarmTask[] = [];
  for (const [subIdx, gapPlan] of gapPlans.entries()) {
    if (gapPlan.queries.length === 0) continue;
    tasks.push({
      ...buildTaskBase(profile, cfg),
      id: `gap-${gapPlan.role}-r${round}-s${subIdx}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: gapPlan.role,
      label: subIdx > 0 ? `${gapPlan.label} #${subIdx + 1}` : gapPlan.label,
      queries: [...gapPlan.queries],
      pageBudget: profile.pageBudgetPerGapWorker,
      followLinks: cfg.enableLinkFollowing && gapPlan.followLinks,
      preferredTiers: gapPlan.preferredTiers,
    });
  }
  return tasks;
}

async function runTaskGroup(
  tasks: ReadonlyArray<SwarmTask>,
  state: SharedCrawlState,
  pool: DdgLimiterPool,
  signal: AbortSignal,
  status: StatusFn,
  warn: WarnFn,
  topicKeywords: ReadonlyArray<string>,
): Promise<WorkerResult[]> {
  return Promise.all(
    tasks.map((task) => {
      const limiter = pool.next();
      return runWorker(
        task,
        state,
        signal,
        status,
        warn,
        topicKeywords,
        limiter,
      ).catch((err: unknown) => {
        if (!isAbortError(err)) {
          warn(`[${task.label}] crashed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return {
          taskId: task.id,
          role: task.role,
          label: task.label,
          sources: [],
          queries: [],
          errors: [String(err)],
        } satisfies WorkerResult;
      });
    }),
  );
}

export interface OrchestratorResult {
  readonly sources: ReadonlyArray<CrawledSource>;
  readonly queriesUsed: ReadonlyArray<string>;
  readonly workerErrors: ReadonlyArray<string>;
  readonly usedAI: boolean;
  readonly topicKeywords: ReadonlyArray<string>;
}

export async function runSwarm(
  cfg: ResearchConfig,
  profile: DepthProfile,
  status: StatusFn,
  warn: WarnFn,
  signal: AbortSignal,
): Promise<OrchestratorResult> {
  const fileStatus: StatusFn = (msg: string) => { log(msg); status(msg); };
  const fileWarn: WarnFn = (msg: string) => { log(`[WARN] ${msg}`); warn(msg); };

  const state = new MutableCrawlState();
  state.pruneVisitedCache();
  const cache = state.cacheStats();
  const allSources: CrawledSource[] = [];
  const allQueries: string[] = [];
  const allErrors: string[] = [];
  let usedAI = false;
  let coveredIds: ReturnType<typeof detectCoveredDimensions> = [];
  const startTime = Date.now();
  const maxMs = cfg.maxSessionMs ?? Number.POSITIVE_INFINITY;

  resetThrottle();
  const pool = new DdgLimiterPool(profile.searchLanes, profile.ddgRateLimitMs);

  fileStatus(
    `\n══════════════════════════════════════════════════════════╗\n` +
    `║ 🚀 DEEP RESEARCH SWARM LAUNCHED ║\n` +
    `╠══════════════════════════════════════════════════════════╣\n` +
    `║ 📋 Topic: ${cfg.topic.slice(0, 45).padEnd(45)}║\n` +
    `║ ⚙️ Depth: ${cfg.depthPreset.padEnd(46)}║\n` +
    `║ 🔄 Rounds: ${String(profile.depthRounds).padEnd(44)}║\n` +
    `║ 📄 Pages/Worker: ${String(profile.pageBudgetPerWorker).padEnd(38)}║\n` +
    `║  Search Lanes: ${String(profile.searchLanes).padEnd(38)}║\n` +
    `║ 👥 Fan-out: ×${String(profile.workerFanOut).padEnd(43)}║\n` +
    `║ 📚 Local Sources: ${(cfg.enableLocalSources ? "Enabled" : "Disabled").padEnd(39)}║\n` +
    `╚══════════════════════════════════════════════════════════╝\n`,
  );
  fileStatus(`[CACHE] file=${cache.file} entries=${cache.entries} pruned=0 max_age_days=30`);

  const plan = await buildQueryPlan(
    cfg.topic,
    cfg.focusAreas,
    cfg.enableAIPlanning,
    fileStatus,
    profile,
  );
  usedAI = plan.usedAI;
  const roles = rolesForProfile(profile);
  const round1Tasks = buildRound1Tasks(roles, plan.queriesByRole, profile, cfg);

  const round1Results = await runTaskGroup(
    round1Tasks,
    state,
    pool,
    signal,
    fileStatus,
    fileWarn,
    plan.topicKeywords,
  );
  aggregateResults(round1Results, allSources, allQueries, allErrors);
  coveredIds = detectCoveredDimensions(allQueries);
  logAggregateMetrics(state, fileStatus, "ROUND 1");

  fileStatus(
    `\nRound 1 Complete\n` +
    `📦 Total Sources: ${allSources.length}\n` +
    ` Active Workers: ${round1Tasks.length}\n` +
    `🔍 Queries Used: ${allQueries.length}\n` +
    `${formatProgressBar(allSources.length, profile.pageBudgetPerWorker * Math.max(round1Tasks.length, 1))}\n`,
  );

  let priorMessages: ReadonlyArray<AgentMessage> = [];
  if (profile.depthRounds > 1 && cfg.enableAIPlanning) {
    fileStatus(`\nSummarising Round 1 findings for gap-fill workers…`);
    priorMessages = await summariseFindings(
      allSources,
      cfg.topic,
      cfg.enableAIPlanning,
      fileStatus,
    );
  }

  let consecutiveStagnant = 0;
  for (let round = 2; round <= profile.depthRounds; round++) {
    if (signal.aborted) break;
    if (Date.now() - startTime >= maxMs) {
      fileStatus(
        `\nTime Limit Reached\n` +
        `Stopped at Round: ${round}/${profile.depthRounds}\n` +
        `📦 Sources Collected: ${allSources.length}\n` +
        ` Queries Executed: ${allQueries.length}\n`,
      );
      break;
    }
    fileStatus(
      `\nAnalysing Research Gaps - Round ${round}\n` +
      `✅ Dimensions Covered: ${coveredIds.length}/${DIMENSIONS.length}\n` +
      `📊 Coverage: ${((coveredIds.length / DIMENSIONS.length) * 100).toFixed(0)}%\n` +
      ` ${formatProgressBar(coveredIds.length, DIMENSIONS.length)}\n`,
    );
    const gapPlans = await buildAdaptiveGapFill(
      cfg.topic,
      coveredIds,
      priorMessages,
      cfg.enableAIPlanning,
      fileStatus,
      profile,
    );
    if (gapPlans.length === 0) {
      fileStatus("✅ Research coverage is comprehensive, stopping early");
      break;
    }
    const sourcesBefore = allSources.length;
    const gapTasks = buildGapTasks(gapPlans as ReadonlyArray<GapPlanLike>, round, profile, cfg);
    const gapResults = await runTaskGroup(
      gapTasks,
      state,
      pool,
      signal,
      fileStatus,
      fileWarn,
      plan.topicKeywords,
    );
    aggregateResults(gapResults, allSources, allQueries, allErrors);
    coveredIds = detectCoveredDimensions(allQueries);
    const newSources = allSources.length - sourcesBefore;
    logAggregateMetrics(state, fileStatus, `ROUND ${round}`);
    fileStatus(
      `\n📊 Round ${round} Summary\n` +
      `➕ New Sources: ${newSources}\n` +
      `📦 Total Sources: ${allSources.length}\n` +
      `🔍 Total Queries: ${allQueries.length}\n` +
      ` ${formatProgressBar(allSources.length, profile.pageBudgetPerWorker * Math.max(profile.depthRounds, 1) * 10)}\n`,
    );
    if (newSources === 0) {
      consecutiveStagnant++;
      if (consecutiveStagnant >= profile.stagnationThreshold) {
        fileStatus(
          `\n Research Complete - Stagnation Detected\n` +
          `Consecutive Stagnant Rounds: ${consecutiveStagnant}\n` +
          `📦 Final Source Count: ${allSources.length}\n` +
          `🔍 Total Queries Executed: ${allQueries.length}\n` +
          `❌ Worker Errors: ${allErrors.length}\n`,
        );
        break;
      }
    } else {
      consecutiveStagnant = 0;
    }
    if (newSources > 0 && round < profile.depthRounds && cfg.enableAIPlanning) {
      priorMessages = await summariseFindings(
        allSources,
        cfg.topic,
        cfg.enableAIPlanning,
        fileStatus,
      );
    }
  }

  logAggregateMetrics(state, fileStatus, "FINAL");

  const total429 = allErrors.filter((e) => e.toLowerCase().includes("429") || e.toLowerCase().includes("too many requests")).length;
  if (total429 > 5) {
    fileWarn(`\n⚠️ SEVERE RATE LIMITING DETECTED: ${total429} blocks. Consider increasing ddgRateLimitMs.`);
  }

  return {
    sources: allSources,
    queriesUsed: [...new Set(allQueries)],
    workerErrors: allErrors,
    usedAI,
    topicKeywords: plan.topicKeywords,
  };
}

function logAggregateMetrics(
  state: SharedCrawlState,
  status: StatusFn,
  label: string,
): void {
  const m = state.getMetricsSnapshot();
  const cacheHitRate = percent(m.cacheHits, m.cacheChecks);
  const cacheAcceptRate = percent(m.cacheAccepted, m.cacheHits);
  const fetchSuccessRate = percent(m.acceptedSources - m.cacheAccepted, m.fetchAttempts);
  const dedupeRate = percent(m.rawHits - m.dedupedHits, m.rawHits);
  status(`[${label}] search ddg_queries=${m.ddgQueries} ddg_hits=${m.ddgHits} mutation_accepted=${m.mutationAccepted} mutation_hits=${m.mutationHits} extra_hits=${m.extraEngineHits}`);
  status(`[${label}] quality raw_hits=${m.rawHits} deduped_hits=${m.dedupedHits} dedupe_rate=${dedupeRate}% ranked=${m.rankedCandidates} accepted=${m.acceptedSources} fetch_success=${fetchSuccessRate}%`);
  status(`[${label}] cache checks=${m.cacheChecks} hits=${m.cacheHits} hit_rate=${cacheHitRate}% accepted=${m.cacheAccepted} accept_rate=${cacheAcceptRate}% writes=${m.cacheWrites}`);
  status(`[${label}] skips visited=${m.skippedVisited} dup=${m.skippedDuplicateContent} off_topic=${m.skippedOffTopic} very_off_topic=${m.skippedVeryOffTopic} low_words=${m.skippedLowWordCount} domain_cap=${m.skippedDomainCap} avoided=${m.skippedAvoided} blacklisted=${m.skippedBlacklisted}`);
}

function aggregateResults(
  results: ReadonlyArray<WorkerResult>,
  sources: CrawledSource[],
  queries: string[],
  errors: string[],
): void {
  for (const result of results) {
    sources.push(...result.sources);
    queries.push(...result.queries);
    errors.push(...result.errors);
  }
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www./, "");
  } catch {
    return "";
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}