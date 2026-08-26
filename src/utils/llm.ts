// src/utils/llm.ts
import { LlmCallBudget, RunWatchdog, ContextIsolationMode } from "../types";

const BUDGETS: Record<string, LlmCallBudget> = {
  compact: { mode: "compact", maxGlobalCalls: 20, maxCallsPerWorker: 3, maxRuntimeMs: 10 * 60 * 1000, warningThresholdMs: 8 * 60 * 1000 },
  standard: { mode: "standard", maxGlobalCalls: 45, maxCallsPerWorker: 5, maxRuntimeMs: 20 * 60 * 1000, warningThresholdMs: 15 * 60 * 1000 },
  deep: { mode: "deep", maxGlobalCalls: 80, maxCallsPerWorker: 8, maxRuntimeMs: 30 * 60 * 1000, warningThresholdMs: 25 * 60 * 1000 },
  extended: { mode: "extended", maxGlobalCalls: 120, maxCallsPerWorker: 10, maxRuntimeMs: 45 * 60 * 1000, warningThresholdMs: 40 * 60 * 1000 },
};

export class LlmCallManager {
  public budget: LlmCallBudget;
  public watchdog: RunWatchdog;
  public isolationMode: ContextIsolationMode;

  constructor(mode: string = "standard", isolationMode: ContextIsolationMode = "strict") {
    this.budget = BUDGETS[mode] || BUDGETS.standard;
    this.isolationMode = isolationMode;
    this.watchdog = {
      llmCallsMade: 0,
      workerCalls: new Map(),
      startTime: Date.now(),
      stalled: false,
      lastProgressTime: Date.now(),
    };
  }

  public canCall(workerId: string): boolean {
    if (this.watchdog.stalled) return false;
    if (this.watchdog.llmCallsMade >= this.budget.maxGlobalCalls) return false;
    
    const workerCalls = this.watchdog.workerCalls.get(workerId) ?? 0;
    if (workerCalls >= this.budget.maxCallsPerWorker) return false;

    if (Date.now() - this.watchdog.startTime > this.budget.maxRuntimeMs) return false;

    return true;
  }

  public recordCall(workerId: string) {
    this.watchdog.llmCallsMade++;
    this.watchdog.workerCalls.set(workerId, (this.watchdog.workerCalls.get(workerId) ?? 0) + 1);
  }

  public recordProgress() {
    this.watchdog.lastProgressTime = Date.now();
    this.watchdog.stalled = false;
  }

  public checkStall(): boolean {
    // Stall if no progress for 2 minutes
    if (Date.now() - this.watchdog.lastProgressTime > 2 * 60 * 1000) {
      this.watchdog.stalled = true;
      return true;
    }
    return false;
  }

  public shouldStop(): boolean {
    if (this.watchdog.stalled) return true;
    if (this.watchdog.llmCallsMade >= this.budget.maxGlobalCalls) return true;
    if (Date.now() - this.watchdog.startTime > this.budget.maxRuntimeMs) return true;
    return false;
  }

  public getReport(): string {
    const elapsedMs = Date.now() - this.watchdog.startTime;
    const elapsedMin = Math.floor(elapsedMs / 60000);
    
    return `
══════════════════════════════════════════════════════════════
RUN CONTROL & WATCHDOG REPORT
══════════════════════════════════════════════════════════════
- Selected mode: ${this.budget.mode}
- Runtime limit: ${this.budget.maxRuntimeMs / 60000} min
- Runtime elapsed: ${elapsedMin} min
- LLM call budget: ${this.budget.maxGlobalCalls}
- LLM calls used: ${this.watchdog.llmCallsMade}
- Worker calls: ${JSON.stringify(Object.fromEntries(this.watchdog.workerCalls))}
- Stall detector state: ${this.watchdog.stalled ? "STALLED" : "HEALTHY"}
- Context Isolation: ${this.isolationMode}
══════════════════════════════════════════════════════════════
`;
  }
}