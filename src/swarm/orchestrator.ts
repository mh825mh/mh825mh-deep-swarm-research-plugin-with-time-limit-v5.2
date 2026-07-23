/**
 * @file swarm/orchestrator.ts
 * The swarm orchestrator with:
 * - Worker fan-out: each role spawns N sub-workers in parallel
 * - Multi-lane DDG rate limiters: true parallel search across lanes
 * - 10 specialized worker roles (up from 5)
 * - Adaptive collection with stagnation + coverage termination
 */

import { runWorker, SharedCrawlState } from "./worker";
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
  DynamicWorkerSpec,
  AgentMessage,
  StatusFn,
  WarnFn,
} from "../types";
import { DepthProfile } from "../constants";
import { DdgRateLimiter, DdgLimiterPool, resetThrottle } from "../net/ddg";

class MutableCrawlState implements SharedCrawlState {
  private readonly _visitedUrls = new Set<string>();
  private readonly _contentHashes = new Set<string>();
  private readonly _domainCounts = new Map<string, number>();
  private readonly discoveries: Array<{
    url: string;
    title: string;
    fromWorker: string;
  }> = [];

  private readonly failedUrls = new Map<
    string,
    { count: number; reason: string; lastFailedAt: string }
  >();

  private readonly failedHosts = new Map<
    string,
    { count: number; reason: string; lastFailedAt: string }
  >();

  get visitedUrls(): ReadonlySet<string> {
    return this._visitedUrls;
  }

  get contentHashes(): ReadonlySet<string> {
    return this._contentHashes;
  }

  get domainCounts(): ReadonlyMap<string, number> {
    return this._domainCounts;
  }

  addVisited(url: string): void {
    this._visitedUrls.add(url);
  }

  addHash(hash: string): void {
    this._contentHashes.add(hash);
  }

  incrementDomain(url: string): void {
    const host = safeHostname(url);
    if (host) {
      this._domainCounts.set(host, (this._domainCounts.get(host) ?? 0) + 1);
    }
  }

  domainCount(url: string): number {
    return this._domainCounts.get(safeHostname(url)) ?? 0;
  }

  pushDiscovery(url: string, title: string, fromWorker: string): void {
    if (!this._visitedUrls.has(url)) {
      this.discoveries.push({ url, title, fromWorker });
    }
  }

  drainDiscoveries(limit: number): ReadonlyArray<{ url: string; title: string }> {
    const results: Array<{ url: string; title: string }> = [];

    while (results.length < limit && this.discoveries.length > 0) {
      const item = this.discoveries.shift()!;
      if (!this._visitedUrls.has(item.url)) {
        results.push({ url: item.url, title: item.title });
      }
    }

    return results;
  }

  noteFailure(
    url: string,
    reason: string,
    at: string = new Date().toISOString(),
  ): void {
    const prevUrl = this.failedUrls.get(url);
    this.failedUrls.set(url, {
      count: (prevUrl?.count ?? 0) + 1,
      reason,
      lastFailedAt: at,
    });

    const host = safeHostname(url);
    if (!host) return;

    const prevHost = this.failedHosts.get(host);
    this.failedHosts.set(host, {
      count: (prevHost?.count ?? 0) + 1,
      reason,
      lastFailedAt: at,
    });
  }

  shouldAvoidUrl(url: string): boolean {
    if (this.failedUrls.has(url)) return true;

    const host = safeHostname(url);
    if (!host) return false;

    const hostFailCount = this.failedHosts.get(host)?.count ?? 0;
    return hostFailCount >= 2;
  }
}

/** Core roles always used. */
const CORE_ROLES: ReadonlyArray<WorkerRole> = [
  "breadth",
  "depth",
  "recency",
  "academic",
  "critical",
];

/** Extended roles added for deep/deeper/exhaustive presets. */
const EXTENDED_ROLES: ReadonlyArray<WorkerRole> = [
  "statistical",
  "regulatory",
  "technical",
  "primary",
  "comparative",
];

const ROLE_LABELS: Readonly<Record<WorkerRole, string>> = {
  breadth: "Breadth",
  depth: "Depth",
  recency: "Recency",
  academic: "Academic",
  critical: "Critical",
  statistical: "Statistical/Data",
  regulatory: "Regulatory/Policy",
  technical: "Technical Deep-Dive",
  primary: "Primary Sources",
  comparative: "Comparative Analysis",
};

function rolesForProfile(profile: DepthProfile): ReadonlyArray<WorkerRole> {
  if (profile.depthRounds >= 10) return [...CORE_ROLES, ...EXTENDED_ROLES];
  if (profile.depthRounds >= 5)
    return [...CORE_ROLES, "technical", "comparative", "statistical"];
  return [...CORE_ROLES];
}

function buildTaskBase(
  profile: DepthProfile,
  cfg: ResearchConfig,
): Pick<
  SwarmTask,
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

function buildDynamicTask(
  spec: DynamicWorkerSpec,
  profile: DepthProfile,
  cfg: ResearchConfig,
  subIdx: number = 0,
): SwarmTask {
  const proportional = Math.round(
    profile.pageBudgetPerWorker * spec.budgetWeight * 2,
  );
  const minBudget = Math.ceil(profile.pageBudgetPerWorker / 2);
  return {
    ...buildTaskBase(profile, cfg),
    id: `${spec.role}-${spec.label.slice(0, 20)}-s${subIdx}-${Date.now()}`,
    role: spec.role,
    label: subIdx > 0 ? `${spec.label} #${subIdx + 1}` : spec.label,
    queries: spec.queries,
    pageBudget: Math.max(proportional, minBudget),
    followLinks: cfg.enableLinkFollowing && spec.followLinks,
    preferredTiers: spec.preferredTiers,
  };
}

function buildStaticTask(
  role: WorkerRole,
  queries: ReadonlyArray<string>,
  profile: DepthProfile,
  cfg: ResearchConfig,
  subIdx: number = 0,
): SwarmTask {
  const followRoles: ReadonlyArray<WorkerRole> = [
    "depth",
    "academic",
    "technical",
    "primary",
  ];
  const academicTiers = ["academic", "government", "reference"] as const;
  return {
    ...buildTaskBase(profile, cfg),
    id: `${role}-s${subIdx}-${Date.now()}`,
    role,
    label:
      subIdx > 0 ? `${ROLE_LABELS[role]} #${subIdx + 1}` : ROLE_LABELS[role],
    queries,
    pageBudget: profile.pageBudgetPerWorker,
    followLinks: cfg.enableLinkFollowing && followRoles.includes(role),
    preferredTiers:
      role === "academic" || role === "regulatory" ? academicTiers : undefined,
  };
}

function fanOutQueries(
  queries: ReadonlyArray<string>,
  fanOut: number,
): ReadonlyArray<ReadonlyArray<string>> {
  if (fanOut <= 1 || queries.length <= 2) return [queries];

  const groups: string[][] = [];
  for (let i = 0; i < fanOut; i++) groups.push([]);

  for (let i = 0; i < queries.length; i++) {
    groups[i % fanOut].push(queries[i]);
  }

  return groups.filter((g) => g.length > 0);
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
  const state = new MutableCrawlState();

  const allSources: CrawledSource[] = [];
  const allQueries: string[] = [];
  const allErrors: string[] = [];
  let usedAI = false;
  let coveredIds: ReturnType<typeof detectCoveredDimensions> = [];

  const startTime = Date.now();
  const maxMs = cfg.maxSessionMs ?? Number.POSITIVE_INFINITY;

  resetThrottle();

  const pool = new DdgLimiterPool(profile.searchLanes, profile.ddgRateLimitMs);

  status(
    `\n Launching swarm for: "${cfg.topic}" [${cfg.depthPreset} - ` +
      `${profile.depthRounds} rounds, ${profile.pageBudgetPerWorker} pages/worker, ` +
      `${profile.searchLanes} search lanes, fan-out ×${profile.workerFanOut}` +
      `${cfg.enableLocalSources ? ", local sources enabled" : ""}]`,
  );

  const plan = await buildQueryPlan(
    cfg.topic,
    cfg.focusAreas,
    cfg.enableAIPlanning,
    status,
    profile,
  );
  usedAI = plan.usedAI;

  let round1Tasks: SwarmTask[] = [];

  // ... existing round1 task build logic ...

  const round1Results = await Promise.all(
    round1Tasks.map((task) => {
      const limiter = pool.next();
      return runWorker(
        task,
        state,
        signal,
        status,
        warn,
        plan.topicKeywords,
        limiter,
      ).catch((err) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          warn(
            `Worker ${task.label} crashed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return {
          taskId: task.id,
          role: task.role,
          label: task.label,
          sources: [] as CrawledSource[],
          queries: [] as string[],
          errors: [String(err)],
        } satisfies WorkerResult;
      });
    }),
  );

  aggregateResults(round1Results, allSources, allQueries, allErrors);
 coveredIds = detectCoveredDimensions(allQueries);

  status(
    `\n Round 1 complete - ${allSources.length} sources from ${round1Tasks.length} parallel workers`,
  );

  let priorMessages: ReadonlyArray<AgentMessage> = [];
  if (profile.depthRounds > 1 && cfg.enableAIPlanning) {
    status(`\n Summarising Round 1 findings for gap-fill workers…`);
    priorMessages = await summariseFindings(
      allSources,
      cfg.topic,
      cfg.enableAIPlanning,
      status,
    );
  }

  let consecutiveStagnant = 0;

  for (let round = 2; round <= profile.depthRounds; round++) {
    if (signal.aborted) break;

    if (Date.now() - startTime >= maxMs) {
      status(
        `\n Max session time reached — stopping swarm at round ${round} with ` +
          `${allSources.length} sources collected so far.`,
      );
      break;
    }

    status(
      `\n Analysing coverage gaps for round ${round} (${coveredIds.length}/${DIMENSIONS.length} dimensions covered)…`,
    );

    const gapPlans = await buildAdaptiveGapFill(
      cfg.topic,
      coveredIds,
      priorMessages,
      cfg.enableAIPlanning,
      status,
      profile,
    );

    if (gapPlans.length === 0) {
      status("Research coverage is comprehensive, stopping early");
      break;
    }

    const sourcesBefore = allSources.length;

    const gapTasks: SwarmTask[] = [];
    for (const gapPlan of gapPlans) {
      gapTasks.push({
        ...buildTaskBase(profile, cfg),
        id: `gap-${gapPlan.role}-r${round}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: gapPlan.role,
        label: gapPlan.label,
        queries: gapPlan.queries,
        pageBudget: profile.pageBudgetPerGapWorker,
        followLinks: cfg.enableLinkFollowing && gapPlan.followLinks,
        preferredTiers: gapPlan.preferredTiers,
      });
    }

    const gapResults = await Promise.all(
      gapTasks.map((task) => {
        const limiter = pool.next();
        return runWorker(
          task,
          state,
          signal,
          status,
          warn,
          task.queries,
          limiter,
        ).catch(
          (err) =>
            ({
              taskId: task.id,
              role: task.role,
              label: task.label,
              sources: [] as CrawledSource[],
              queries: [] as string[],
              errors: [String(err)],
            }) satisfies WorkerResult,
        );
      }),
    );

    aggregateResults(gapResults, allSources, allQueries, allErrors);
    coveredIds = detectCoveredDimensions(allQueries);

    const newSources = allSources.length - sourcesBefore;
    status(
      `Round ${round} done - ${newSources} new sources this round, ${allSources.length} total`,
    );

    if (newSources === 0) {
      consecutiveStagnant++;
      if (consecutiveStagnant >= profile.stagnationThreshold) {
        status(
          `\n ${consecutiveStagnant} consecutive round(s) with no new sources - stopping (stagnation)`,
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
        status,
      );
    }
  }

  return {
    sources: allSources,
    queriesUsed: [...new Set(allQueries)],
    workerErrors: allErrors,
    usedAI,
    topicKeywords: plan.topicKeywords,
  };
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

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
