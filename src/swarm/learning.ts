/**
 * Persistent heuristic learning for the Deep Swarm Research plugin.
 *
 * The plugin cannot modify its own code or model weights, so "self-improvement"
 * here means persisting outcome statistics across runs and biasing future
 * heuristics (engine order, mutation strategy order, domain scoring) toward
 * what has historically worked. All state lives under ~/.deep-swarm-research/.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_DIR = path.join(os.homedir(), ".deep-swarm-research");

function ensureDir(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

abstract class JsonStore<T> {
  private readonly filePath: string;
  private data: T;
  private saveTimer: NodeJS.Timeout | null = null;

  protected constructor(fileName: string, seed: T) {
    this.filePath = path.join(DATA_DIR, fileName);
    this.data = this.load(seed);
  }

  protected get value(): T {
    return this.data;
  }

  protected mutate(fn: (data: T) => void): void {
    try {
      fn(this.data);
    } catch {
      return;
    }
    this.scheduleSave();
  }

  private load(seed: T): T {
    try {
      ensureDir();
      if (!fs.existsSync(this.filePath)) return seed;
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as T;
      return parsed ?? seed;
    } catch {
      return seed;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        ensureDir();
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
      } catch {
        /* ignore */
      }
    }, 250);
    if (typeof this.saveTimer.unref === "function") this.saveTimer.unref();
  }
}

// ---------------------------------------------------------------------------
// Engine performance (drives "priority" engine selection mode)
// ---------------------------------------------------------------------------

export interface EngineStatEntry {
  /** Exponential moving average of success (0..1). */
  score: number;
  /** Total search hits attributed to this engine. */
  hits: number;
  /** Number of recorded queries/outcomes. */
  samples: number;
  lastUpdated: string;
}

interface EngineStatsFile {
  version: 1;
  engines: Record<string, EngineStatEntry>;
}

const EMA_ALPHA = 0.2;
const DEFAULT_ENGINE_SCORE = 0.5;

export class EngineStatsStore extends JsonStore<EngineStatsFile> {
  constructor() {
    super("engine-stats.json", { version: 1, engines: {} });
  }

  record(engine: string, hitCount: number): void {
    if (!engine) return;
    this.mutate((data) => {
      const prev = data.engines[engine] ?? {
        score: DEFAULT_ENGINE_SCORE,
        hits: 0,
        samples: 0,
        lastUpdated: new Date().toISOString(),
      };
      const success = hitCount > 0 ? 1 : 0;
      data.engines[engine] = {
        score: prev.score * (1 - EMA_ALPHA) + success * EMA_ALPHA,
        hits: prev.hits + Math.max(0, hitCount),
        samples: prev.samples + 1,
        lastUpdated: new Date().toISOString(),
      };
    });
  }

  scoreOf(engine: string): number {
    return this.value.engines[engine]?.score ?? DEFAULT_ENGINE_SCORE;
  }

  /** Stable sort of engine identifiers by historical success (best first). */
  orderEngines(engines: ReadonlyArray<string>): string[] {
    return [...engines]
      .map((engine, index) => ({ engine, index, score: this.scoreOf(engine) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((e) => e.engine);
  }
}

// ---------------------------------------------------------------------------
// Mutation strategy performance
// ---------------------------------------------------------------------------

interface MutationStatEntry {
  score: number;
  accepted: number;
  tried: number;
}

interface MutationStatsFile {
  version: 1;
  global: MutationStatEntry[];
  byRole: Record<string, MutationStatEntry[]>;
}

function emptyMutationEntry(): MutationStatEntry {
  return { score: 0.5, accepted: 0, tried: 0 };
}

export class MutationStatsStore extends JsonStore<MutationStatsFile> {
  constructor() {
    super("mutation-stats.json", { version: 1, global: [], byRole: {} });
  }

  private entryAt(role: string | undefined, index: number): MutationStatEntry {
    const scope = role ? this.value.byRole[role] ?? [] : this.value.global;
    return scope[index] ?? emptyMutationEntry();
  }

  scoreAt(index: number, role?: string): number {
    return this.entryAt(role, index).score;
  }

  record(index: number, accepted: boolean, role?: string): void {
    this.mutate((data) => {
      const bump = (arr: MutationStatEntry[]): MutationStatEntry[] => {
        const next = [...arr];
        while (next.length <= index) next.push(emptyMutationEntry());
        const prev = next[index] ?? emptyMutationEntry();
        next[index] = {
          score: prev.score * (1 - EMA_ALPHA) + (accepted ? 1 : 0) * EMA_ALPHA,
          accepted: prev.accepted + (accepted ? 1 : 0),
          tried: prev.tried + 1,
        };
        return next;
      };
      data.global = bump(data.global);
      if (role) data.byRole[role] = bump(data.byRole[role] ?? []);
    });
  }

  /** Indices 0..count-1 ordered by historical success (best first). */
  rankIndices(count: number, role?: string): number[] {
    return Array.from({ length: count }, (_, i) => i)
      .map((index) => ({ index, score: this.scoreAt(index, role) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((e) => e.index);
  }
}

// ---------------------------------------------------------------------------
// Domain acceptance adjustments
// ---------------------------------------------------------------------------

export interface DomainAdjEntry {
  score: number;
  accepted: number;
  seen: number;
}

interface DomainAdjFile {
  version: 1;
  domains: Record<string, DomainAdjEntry>;
}

export class DomainAdjustmentsStore extends JsonStore<DomainAdjFile> {
  constructor() {
    super("domain-adjustments.json", { version: 1, domains: {} });
  }

  record(host: string, accepted: boolean): void {
    if (!host) return;
    this.mutate((data) => {
      const prev = data.domains[host] ?? { score: 0.5, accepted: 0, seen: 0 };
      data.domains[host] = {
        score: prev.score * (1 - EMA_ALPHA) + (accepted ? 1 : 0) * EMA_ALPHA,
        accepted: prev.accepted + (accepted ? 1 : 0),
        seen: prev.seen + 1,
      };
    });
  }

  /** Small score delta (roughly -10..+15) applied to a domain's candidate score. */
  adjustment(host: string): number {
    const entry = this.value.domains[host];
    if (!entry || entry.seen < 3) return 0;
    // score 0.5 -> 0 ; 1.0 -> +15 ; 0.0 -> -10
    return entry.score >= 0.5 ? (entry.score - 0.5) * 30 : (entry.score - 0.5) * 20;
  }

  /** Enumeration of known host adjustments (host, score, accepted, seen). */
  entries(): ReadonlyArray<{ readonly host: string; readonly score: number; readonly accepted: number; readonly seen: number }> {
    return Object.entries(this.value.domains).map(([host, e]) => ({
      host,
      score: e.score,
      accepted: e.accepted,
      seen: e.seen,
    }));
  }
}

// ---------------------------------------------------------------------------
// Learned hints (LLM self-reflection over prior runs)
// ---------------------------------------------------------------------------

interface LearnedHintsFile {
  version: 1;
  hints: string[];
  updatedAt: string;
}

const MAX_HINTS = 20;

export class LearnedHintsStore extends JsonStore<LearnedHintsFile> {
  constructor() {
    super("learned-hints.json", { version: 1, hints: [], updatedAt: "" });
  }

  all(): ReadonlyArray<string> {
    return this.value.hints;
  }

  addHints(hints: ReadonlyArray<string>): void {
    const cleaned = hints
      .map((h) => h.replace(/\s+/g, " ").trim())
      .filter((h) => h.length >= 8 && h.length <= 240);
    if (cleaned.length === 0) return;
    this.mutate((data) => {
      const merged = [...cleaned, ...data.hints];
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const hint of merged) {
        const key = hint.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(hint);
        if (deduped.length >= MAX_HINTS) break;
      }
      data.hints = deduped;
      data.updatedAt = new Date().toISOString();
    });
  }
}

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

let engineStatsSingleton: EngineStatsStore | null = null;
let mutationStatsSingleton: MutationStatsStore | null = null;
let domainAdjustmentsSingleton: DomainAdjustmentsStore | null = null;
let learnedHintsSingleton: LearnedHintsStore | null = null;

export function getEngineStats(): EngineStatsStore {
  return (engineStatsSingleton ??= new EngineStatsStore());
}

export function getMutationStats(): MutationStatsStore {
  return (mutationStatsSingleton ??= new MutationStatsStore());
}

export function getDomainAdjustments(): DomainAdjustmentsStore {
  return (domainAdjustmentsSingleton ??= new DomainAdjustmentsStore());
}

export function getLearnedHints(): LearnedHintsStore {
  return (learnedHintsSingleton ??= new LearnedHintsStore());
}
