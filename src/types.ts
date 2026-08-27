export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly discoveredBy?: string;
  readonly requestedRoute?: string;
  readonly actualBackend?: string;
  readonly resultDomain?: string;
}

export type VerificationTier = "A" | "B" | "C" | "REJECTED";
export type ClaimStrength = "documented" | "disputed" | "anecdote" | "speculation";

export interface Outlink {
  readonly text: string;
  readonly href: string;
}

export interface ExtractedPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly description: string;
  readonly published: string | null;
  readonly text: string;
  readonly wordCount: number;
  readonly outlinks: ReadonlyArray<Outlink>;
  readonly page?: number;
  readonly totalPages?: number;
}

export interface EntityMetadata {
  canonicalEntities?: ReadonlyArray<string>;
  author?: string;
  publisher?: string;
  officialUrl?: string;
  isSkepticOrReplication?: boolean;
}

export interface EvidenceCard {
  readonly id: string;
  readonly entityType: "book" | "podcast" | "standard" | "article" | "local document" | "web";
  readonly title: string;
  readonly authorOrHost: string;
  readonly canonicalUrl: string;
  readonly sourceTier: SourceTier;
  readonly relevantClaim: string;
  readonly supportingExcerpt: string;
  readonly confidence: "High" | "Medium" | "Low";
  readonly claimStrength: ClaimStrength;
  readonly freshness: string | null;
  readonly worker: string;
  readonly verificationTier: VerificationTier;
  readonly metadataConfidence: number;
  readonly topicFit: number;
  readonly recommendationStrength: number;
  readonly entityMetadata: EntityMetadata;
}

export interface CompiledReport {
  readonly markdown: string;
  readonly sources: ReadonlyArray<ReportSource>;
  readonly topicKeywords: ReadonlyArray<string>;
  readonly coveredDims: ReadonlyArray<string>;
  readonly gapDims: ReadonlyArray<string>;
  readonly aiSynthesis?: string;
  readonly contradictions: ReadonlyArray<ContradictionEntry>;
  readonly isPartialRun?: boolean;
  readonly timeoutReason?: string;
}

export interface Outlink {
  readonly text: string;
  readonly href: string;
}

export type SourceTier =
  | "academic"
  | "government"
  | "reference"
  | "news"
  | "professional"
  | "general"
  | "low";

export interface ScoredCandidate {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly query: string;
  readonly domainScore: number;
  readonly freshnessScore: number;
  readonly urlQuality: number;
  readonly totalScore: number;
  readonly tier: SourceTier;
  readonly discoveredBy?: string; 
}

export type WorkerRole =
  | "breadth"
  | "depth"
  | "recency"
  | "academic"
  | "critical"
  | "statistical"
  | "regulatory"
  | "technical"
  | "primary"
  | "comparative";

export interface DynamicWorkerSpec {
  readonly role: WorkerRole;
  readonly label: string;
  readonly queries: ReadonlyArray<string>;
  readonly budgetWeight: number;
  readonly followLinks: boolean;
  readonly preferredTiers?: ReadonlyArray<SourceTier>;
}

export interface SwarmTask {
  readonly id: string;
  readonly role: WorkerRole;
  readonly label: string;
  readonly queries: ReadonlyArray<string>;
  readonly pageBudget: number;
  readonly contentLimit: number;
  readonly followLinks: boolean;
  readonly safeSearch: "strict" | "moderate" | "off";
  readonly preferredTiers?: ReadonlyArray<SourceTier>;
  readonly searchResultsPerQuery: number;
  readonly maxPagesPerDomain: number;
  readonly maxLinksToEvaluate: number;
  readonly maxLinksToFollow: number;
  readonly candidatePoolMultiplier: number;
  readonly workerConcurrency: number;
  readonly minRelevanceScore: number;
  readonly maxOutlinksPerPage: number;
  readonly searchPages: number;
  readonly extraEngines: ReadonlyArray<string>;
  readonly linkCrawlDepth: number;
  readonly queryMutationThreshold: number;
  readonly enableLocalSources: boolean;
  readonly enableYouTube?: boolean;
  readonly localLibraryIds?: ReadonlyArray<string>;
  readonly roleLibraryMap?: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly timeRange?: "all" | "year" | "month" | "week" | "day";
  readonly serperApiKey?: string;
  readonly braveApiKey?: string;
}


export interface WorkerResult {
  readonly taskId: string;
  readonly role: WorkerRole;
  readonly label: string;
  readonly sources: ReadonlyArray<CrawledSource>;
  readonly queries: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

export interface CrawledSource {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly description: string;
  readonly published: string | null;
  readonly text: string;
  readonly wordCount: number;
  readonly outlinks: ReadonlyArray<Outlink>;
  readonly sourceQuery: string;
  readonly workerRole: WorkerRole;
  readonly workerLabel: string;
  readonly domainScore: number;
  readonly freshnessScore: number;
  readonly tier: SourceTier;
  readonly relevanceScore: number;
  readonly origin: SourceOrigin;
  readonly discoveredBy?: string; // ADDED: Engine attribution
  readonly page?: number;
  readonly totalPages?: number;
}

export interface AgentMessage {
  readonly fromWorker: string;
  readonly keyFindings: ReadonlyArray<string>;
  readonly suggestedFollowUps: ReadonlyArray<string>;
}

export interface ContradictionEntry {
  readonly claim: string;
  readonly sourceA: {
    readonly index: number;
    readonly title: string;
    readonly stance: string;
  };
  readonly sourceB: {
    readonly index: number;
    readonly title: string;
    readonly stance: string;
  };
  readonly severity: "minor" | "moderate" | "major";
}

export interface ResearchDimension {
  readonly id: string;
  readonly label: string;
  readonly keywords: ReadonlyArray<string>;
  readonly queries: (topic: string) => ReadonlyArray<string>;
}

export interface QueryPlan {
  readonly queriesByRole: Readonly<Record<WorkerRole, ReadonlyArray<string>>>;
  readonly usedAI: boolean;
  readonly topicKeywords: ReadonlyArray<string>;
  readonly dynamicSpecs?: ReadonlyArray<DynamicWorkerSpec>;
}

export interface AdaptiveGapPlan {
  readonly role: WorkerRole;
  readonly label: string;
  readonly queries: ReadonlyArray<string>;
  readonly followLinks: boolean;
  readonly preferredTiers?: ReadonlyArray<SourceTier>;
}

export type SourceOrigin = "web" | "local";

export interface ReportSource {
  readonly index: number;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly published: string | null;
  readonly text: string;
  readonly wordCount: number;
  readonly sourceQuery: string;
  readonly workerRole: WorkerRole;
  readonly workerLabel: string;
  readonly domainScore: number;
  readonly freshnessScore: number;
  readonly tier: SourceTier;
  readonly relevanceScore: number;
  readonly origin: SourceOrigin;
  readonly page?: number;
  readonly totalPages?: number;
}


export interface CompiledReport {
  readonly markdown: string;
  readonly sources: ReadonlyArray<ReportSource>;
  readonly topicKeywords: ReadonlyArray<string>;
  readonly coveredDims: ReadonlyArray<string>;
  readonly gapDims: ReadonlyArray<string>;
  readonly aiSynthesis?: string;
  readonly contradictions: ReadonlyArray<ContradictionEntry>;
}

export interface ResearchConfig {
    readonly contextBudgetMode?: "auto" | "conservative" | "manual";
  readonly manualContextLimit?: number;
  readonly maxSynthesisInputTokens?: number;
  readonly topic: string;
  readonly focusAreas: ReadonlyArray<string>;
  readonly depthPreset: import("./constants").DepthPreset;
  readonly contentLimitPerPage: number;
  readonly contextIsolation?: ContextIsolationMode;
  readonly llmCallMode?: "compact" | "standard" | "deep" | "extended";
  readonly enableLinkFollowing: boolean;
  readonly enableAIPlanning: boolean;
  readonly safeSearch: "strict" | "moderate" | "off";

  /**
   * Enables indexed local RAG libraries as research evidence.
   */
  readonly enableLocalSources: boolean;

  /**
   * Optional allow-list of RAG library UUIDs.
   * When omitted, role-based routing or progressive retrieval is used.
   */
  readonly localLibraryIds?: ReadonlyArray<string>;

  /**
   * Optional worker-role-to-library-ID routing map.
   * Example: { academic: ["uuid"], technical: ["uuid"] }.
   */
  readonly roleLibraryMap?: ReadonlyMap<string, ReadonlyArray<string>>;

  /**
   * Maximum session duration in milliseconds.
   * Omit or set to 0 for no explicit orchestrator time limit.
   */
  readonly maxSessionMs?: number;

  readonly timeRange?: "all" | "year" | "month" | "week" | "day";

  readonly engineSelectionMode?: "adaptive" | "benchmark" | "priority";
  readonly cacheDuration?: string;
  readonly enableXSearch?: boolean;
  readonly enableYouTube?: boolean;
  readonly enableAcademicAPIs?: boolean;
  readonly enableReferenceSearch?: boolean;
  readonly serperApiKey?: string;
  readonly braveApiKey?: string;
}

export interface ResearchResult {
  readonly report: CompiledReport;
  readonly queriesUsed: ReadonlyArray<string>;
  readonly totalSources: number;
  readonly totalRounds: number;
}

export interface EvidenceCard {
  readonly id: string;
  readonly entityType: "book" | "podcast" | "standard" | "article" | "local document" | "web";
  readonly title: string;
  readonly authorOrHost: string;
  readonly canonicalUrl: string;
  readonly sourceTier: SourceTier;
  readonly relevantClaim: string;
  readonly supportingExcerpt: string;
  readonly confidence: "High" | "Medium" | "Low";
  readonly freshness: string | null;
  readonly worker: string;
}

export interface ContextBudget {
  readonly mode: "auto" | "conservative" | "manual";
  readonly modelContextLimit: number;
  readonly outputReserve: number;
  readonly safetyMargin: number;
  readonly maxSynthesisInput: number;
}
export type ContextIsolationMode = "strict" | "worker_reuse" | "advanced_reuse";

export interface LlmCallBudget {
  readonly mode: "compact" | "standard" | "deep" | "extended";
  readonly maxGlobalCalls: number;
  readonly maxCallsPerWorker: number;
  readonly maxRuntimeMs: number;
  readonly warningThresholdMs: number;
}

export interface RunWatchdog {
  llmCallsMade: number;
  workerCalls: Map<string, number>;
  startTime: number;
  stalled: boolean;
  lastProgressTime: number;
}
// Add to SearchHit interface
export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly discoveredBy?: string;
  readonly requestedRoute?: string; // "DDG", "SearxNG", "Direct"
  readonly actualBackend?: string;  // "DDG", "Yandex", "Bing"
  readonly resultDomain?: string;   // "cambridge.org", "orx.org"
}

export type StatusFn = (message: string) => void;
export type WarnFn = (message: string) => void;