// src/utils/llm.ts
import { LMStudioClient } from "@lmstudio/sdk";
import { LlmCallBudget, RunWatchdog, ContextIsolationMode } from "../types";

export interface AskModelOptions {
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export async function askLoadedModel(
  prompt: string,
  options: AskModelOptions = {},
): Promise<string | null> {
  if (options.signal?.aborted) return null;
  const {
    system,
    maxTokens = 400,
    temperature = 0.7,
    timeoutMs = 60_000,
  } = options;

  try {
    const client = new LMStudioClient();
    const models = await Promise.race([
      client.llm.listLoaded(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    if (!Array.isArray(models) || models.length === 0) return null;
    const model = await client.llm.model(models[0].identifier);
    const messages: Array<{ role: "system" | "user"; content: string }> = system
      ? [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ]
      : [{ role: "user", content: prompt }];
    const stream = model.respond(messages, { maxTokens, temperature });
    let result = "";
    for await (const chunk of stream) result += chunk.content ?? "";
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Cheap probe: returns true only if LM Studio has at least one model loaded.
 * Used before consuming an expensive LLM call-budget slot so a research run
 * without a running model doesn't burn its budget on no-op mutation calls.
 */
export async function hasLoadedModel(timeoutMs = 5_000): Promise<boolean> {
  try {
    const client = new LMStudioClient();
    const models = await Promise.race([
      client.llm.listLoaded(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    return Array.isArray(models) && models.length > 0;
  } catch {
    return false;
  }
}

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
  private readonly _abortController: AbortController;

  constructor(mode: string = "standard", isolationMode: ContextIsolationMode = "strict") {
    this.budget = BUDGETS[mode] || BUDGETS.standard;
    this.isolationMode = isolationMode;
    this._abortController = new AbortController();
    this.watchdog = {
      llmCallsMade: 0,
      workerCalls: new Map(),
      startTime: Date.now(),
      stalled: false,
      lastProgressTime: Date.now(),
    };
  }

  public get signal(): AbortSignal {
    return this._abortController.signal;
  }

  public abort(): void {
    if (!this._abortController.signal.aborted) {
      this._abortController.abort();
      this.watchdog.stalled = true;
    }
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