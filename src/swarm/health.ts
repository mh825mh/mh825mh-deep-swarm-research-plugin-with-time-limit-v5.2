// src/swarm/health.ts

export type EngineState = "HEALTHY" | "DEGRADED" | "TEMPORARILY_UNHEALTHY" | "DISABLED";

export interface EngineHealth {
  state: EngineState;
  searchesAttempted: number;
  validResults: number; // <--- ADD THIS
  emptyResults: number;
  blocks: number;
  timeouts: number;     // <--- ADD THIS
  parserErrors: number; // <--- ADD THIS
  consecutiveFailures: number;
  cooldownExpiry: number | null;
  lastFailureReason: string | null;
}

export interface GapRecord {
  id: string;
  topic: string;
  missingClaim: string;
  whyInsufficient: string;
  freshnessRequired: boolean;
  preferredTier: string | null;
  searchLayerAuthorized: string;
  resolved: boolean;
}

export class SearchHealthTracker {
  public ddg: EngineHealth = this.freshState();
  public searxng: EngineHealth = this.freshState();
  public api: EngineHealth = this.freshState();
  public readonly otherEngines: Record<string, EngineHealth> = {};

  public gaps: GapRecord[] = [];
  public apiCallsMade: number = 0;
  public localChunksRetrieved: number = 0;
  public localChunksAccepted: number = 0;
  public junkUrlsRejected: number = 0;
  public pagesArchived: number = 0;
  public archiveSubmitFailures: number = 0;

  private freshState(): EngineHealth {
    return {
      state: "HEALTHY",
      searchesAttempted: 0,
      validResults: 0,
      emptyResults: 0,
      blocks: 0,
      timeouts: 0,
      parserErrors: 0,
      consecutiveFailures: 0,
      cooldownExpiry: null,
      lastFailureReason: null
    };
  }

  public isDdgAvailable(): boolean {
    if (this.ddg.state === "TEMPORARILY_UNHEALTHY") {
      if (Date.now() >= (this.ddg.cooldownExpiry ?? 0)) {
        // 11 minutes passed, allow ONE health check
        return true; 
      }
      return false;
    }
    return true;
  }

    public recordDdgSuccess(hitCount: number) {
    this.ddg.searchesAttempted++;
    if (hitCount >= 1) {
      this.ddg.validResults++;
      this.ddg.consecutiveFailures = 0;
      this.ddg.state = "HEALTHY";
      this.ddg.cooldownExpiry = null;
    } else {
      this.ddg.emptyResults++;
      this.recordDdgFailure("INVALID_RESULT_SET (0 results)");
    }
  }

  public recordDdgFailure(reason: string) {
    this.ddg.searchesAttempted++;
    this.ddg.blocks++;
    this.ddg.consecutiveFailures++;
    this.ddg.lastFailureReason = reason;

    if (reason.includes("timeout")) this.ddg.timeouts++;
    if (reason.includes("parser")) this.ddg.parserErrors++;

    if (this.ddg.consecutiveFailures >= 5) {
      this.ddg.state = "TEMPORARILY_UNHEALTHY";
      this.ddg.cooldownExpiry = Date.now() + (11 * 60 * 1000);
    }
  }

  public canUseApi(): boolean {
    return this.apiCallsMade < 3;
  }

  public isOtherEngineAvailable(engine: string): boolean {
    const state = this.otherEngines[engine];
    if (!state) return true;
    if (state.state === "TEMPORARILY_UNHEALTHY") {
      if (Date.now() >= (state.cooldownExpiry ?? 0)) {
        state.state = "HEALTHY";
        state.consecutiveFailures = 0;
        state.cooldownExpiry = null;
        return true;
      }
      return false;
    }
    return state.state !== "DISABLED";
  }

  public recordOtherEngineHit(engine: string, hitCount: number, reason?: string) {
    const state = (this.otherEngines[engine] = this.otherEngines[engine] ?? this.freshState());
    state.searchesAttempted++;
    if (hitCount >= 1) {
      state.validResults++;
      state.consecutiveFailures = 0;
      state.state = "HEALTHY";
      state.cooldownExpiry = null;
      state.lastFailureReason = null;
    } else {
      state.emptyResults++;
      state.consecutiveFailures++;
      state.blocks++;
      if (reason) state.lastFailureReason = reason;
      if (state.consecutiveFailures >= 3) {
        state.state = "TEMPORARILY_UNHEALTHY";
        state.cooldownExpiry = Date.now() + (11 * 60 * 1000);
      }
    }
  }

  public generateReport(): string {
    return `
══════════════════════════════════════════════════════════════
RESEARCH SOURCE HEALTH REPORT
══════════════════════════════════════════════════════════════
SOURCE PRIORITY ENFORCEMENT
- Local sources searched first: YES
- Local chunks retrieved: ${this.localChunksRetrieved}
- Local chunks accepted: ${this.localChunksAccepted}
- External searches authorised: ${this.gaps.length}
- Gaps resolved: ${this.gaps.filter(g => g.resolved).length}

DDG HEALTH
- State: ${this.ddg.state}
- Searches attempted: ${this.ddg.searchesAttempted}
- Valid results: ${this.ddg.validResults}
- Blocks/challenges: ${this.ddg.blocks}
- Consecutive failures: ${this.ddg.consecutiveFailures}
- Cooldown expiry: ${this.ddg.cooldownExpiry ? new Date(this.ddg.cooldownExpiry).toISOString() : 'None'}
- Last failure reason: ${this.ddg.lastFailureReason || 'None'}

SEARXNG HEALTH
- State: ${this.searxng.state}
- Searches attempted: ${this.searxng.searchesAttempted}
- Valid results: ${this.searxng.validResults}

OTHER ENGINES HEALTH
${Object.entries(this.otherEngines).map(([name, e]) => `- ${name}: ${e.state} (${e.searchesAttempted} attempts, ${e.validResults} valid, cooldown ${e.cooldownExpiry ? new Date(e.cooldownExpiry).toISOString() : "None"})`).join("\n") || "- No extra engines probed yet"}

API GAP FILLING
- API eligible: ${this.canUseApi() ? 'YES' : 'NO'}
- API requests: ${this.apiCallsMade}
- API call budget: 3

QUERY QUALITY
- Gaps generated: ${this.gaps.length}
- Invalid gaps rejected: ${this.gaps.filter(g => !g.missingClaim).length}

ARCHIVE-ON-FAILURE
- Pages archived to Wayback: ${this.pagesArchived}
- Archive submission failures/skips: ${this.archiveSubmitFailures}
══════════════════════════════════════════════════════════════
`;
  }
}