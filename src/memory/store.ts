/**
 * @file memory/store.ts
 * The persistent layered-memory store. Lives under ~/.deep-swarm-research/memory/
 * (one JSON file, debounced writes with an atomic flush), following the JsonStore
 * conventions from src/swarm/learning.ts but kept self-contained.
 *
 * Layers:
 *   - Working  : in-memory only (the MemorySession in retrieve/record). Not persisted.
 *   - Episodic : RunSummary per past run (queries, engine hits, failed urls/hosts,
 *                graded-ledger gist, run stats).
 *   - Semantic : derived facts (consistently off-topic domains, preferences,
 *                domain glossary).
 *   - Procedural: winning query mutations + from other systems.
 *
 * Also ships a self-contained BM25/IoU tokenizer pipeline (mirrors the RAG stack
 * in src/local/store.ts) used to rank memory snippets when no embedding model is
 * loaded.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MEMORY_RETAIN_RUNS_DEFAULT,
  MEMORY_MAX_FACTS,
  MEMORY_MAX_PROCEDURES,
} from "../constants";
import {
  MemoryLayers,
  ProceduralMemory,
  RunSummary,
  SemanticFact,
} from "../types";

const MEMORY_DIR = path.join(os.homedir(), ".deep-swarm-research", "memory");
const DEFAULT_FILE = "run-memory.json";

function ensureDir(): void {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function seedData(): MemoryLayers {
  return { version: 1, runs: [], facts: [], procedures: [] };
}

const BM25_K1 = 1.4;
const BM25_B = 0.75;

const STOP_WORDS = new Set(
  (
    "a an and are as at be but by for from has have how i if in into is it its of on or " +
    "so that the their then there these they this to was we what when where which who why " +
    "will with you your about after also been before between both during each even further " +
    "here however many more most much not only other our own same some such than them through " +
    "too under until very were whether while would research evidence analysis report results"
  ).split(/\s+/),
);

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9\-_]+/)
    .map((t) => t.replace(/^[-_]+|[-_]+$/g, ""))
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function computeTermFrequencies(tokens: string[]): Map<string, number> {
  const freqs = new Map<string, number>();
  for (const token of tokens) freqs.set(token, (freqs.get(token) ?? 0) + 1);
  return freqs;
}

/** A short text record that can be ranked by the BM25 index. */
export interface RankableMemory {
  readonly id: string;
  readonly text: string;
}

/** Lightweight BM25 index over short memory snippets (zero dependencies). */
class MemoryBM25 {
  private readonly docs: RankableMemory[];
  private readonly docFreqs = new Map<string, number>();
  private readonly docLengths: number[];
  private readonly docCount: number;
  private readonly avgDl: number;

  constructor(docs: ReadonlyArray<RankableMemory>) {
    this.docs = [...docs];
    this.docLengths = this.docs.map((d) => tokenize(d.text).length);
    this.docCount = this.docs.length;
    this.avgDl =
      this.docCount > 0
        ? this.docLengths.reduce((sum, n) => sum + n, 0) / this.docCount
        : 1;
    const freqsPerDoc: Array<Set<string>> = this.docLengths.map(() => new Set());
    for (let i = 0; i < this.docs.length; i++) {
      for (const token of tokenize(this.docs[i].text)) freqsPerDoc[i].add(token);
    }
    for (let i = 0; i < this.docs.length; i++) {
      for (const token of freqsPerDoc[i]) {
        this.docFreqs.set(token, (this.docFreqs.get(token) ?? 0) + 1);
      }
    }
  }

  score(query: string, index: number): number {
    const qf = computeTermFrequencies(tokenize(query));
    let score = 0;
    const tokens = tokenize(this.docs[index].text);
    const tf = computeTermFrequencies(tokens);
    const dl = this.docLengths[index] || 1;
    for (const [term, q] of qf) {
      const df = this.docFreqs.get(term) ?? 0;
      if (df === 0) continue;
      const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));
      const termFreq = tf.get(term) ?? 0;
      const tfNorm =
        (termFreq * (BM25_K1 + 1)) /
        (termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (dl / this.avgDl)));
      score += q * idf * tfNorm;
    }
    return score;
  }

  rank(query: string, topN: number): Array<{ id: string; score: number }> {
    const scored = this.docs.map((doc, index) => ({
      id: doc.id,
      score: this.score(query, index),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  }
}

export function rankMemoryByBM25(
  query: string,
  docs: ReadonlyArray<RankableMemory>,
  topN: number,
): Array<{ id: string; score: number }> {
  if (docs.length === 0) return [];
  return new MemoryBM25(docs).rank(query, topN);
}

/** Fraction of the query's distinctive tokens also present in the target text. */
export function keywordOverlapMemory(
  query: string,
  target: string,
): number {
  const distinct = tokenize(query);
  if (distinct.length === 0) return 0;
  const hay = target.toLowerCase();
  const matched = distinct.filter((k) => hay.includes(k)).length;
  return matched / distinct.length;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class MemoryStore {
  private readonly filePath: string;
  private data: MemoryLayers;
  private saveTimer: NodeJS.Timeout | null = null;
  private retainRuns: number;

  constructor(fileName: string = DEFAULT_FILE, retainRuns: number = MEMORY_RETAIN_RUNS_DEFAULT) {
    this.filePath = path.join(MEMORY_DIR, fileName);
    this.retainRuns = Math.max(1, retainRuns);
    this.data = this.load();
  }

  setRetainRuns(n: number): void {
    this.retainRuns = Math.max(1, n);
  }

  // --- reads --------------------------------------------------------------

  runs(): ReadonlyArray<RunSummary> {
    return this.data.runs;
  }

  facts(): ReadonlyArray<SemanticFact> {
    return this.data.facts;
  }

  procedures(): ReadonlyArray<ProceduralMemory> {
    return this.data.procedures;
  }

  overview(): { runCount: number; factCount: number; procedureCount: number } {
    return {
      runCount: this.data.runs.length,
      factCount: this.data.facts.length,
      procedureCount: this.data.procedures.length,
    };
  }

  // --- writes -------------------------------------------------------------

  addRun(summary: RunSummary): void {
    this.mutate((data) => {
      const runs = [...data.runs.filter((r) => r.runId !== summary.runId), summary];
      runs.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
      (data as unknown as { runs: RunSummary[] }).runs = runs.slice(0, this.retainRuns);
    });
  }

  upsertFacts(facts: ReadonlyArray<SemanticFact>): void {
    if (facts.length === 0) return;
    this.mutate((data) => {
      const merged = [...data.facts];
      const keyOf = (f: SemanticFact) =>
        `${f.kind}|${f.source}|${f.text.toLowerCase()}`;
      const seen = new Map<string, number>();
      merged.forEach((f, index) => seen.set(keyOf(f), index));
      for (const fact of facts) {
        const key = keyOf(fact);
        const existing = seen.get(key);
        if (existing !== undefined) {
          const prev = merged[existing];
          merged[existing] = {
            ...prev,
            score: Math.max(prev.score, fact.score),
            timestamp: fact.timestamp,
            topic: fact.topic ?? prev.topic,
            text: fact.text.length >= prev.text.length ? fact.text : prev.text,
          };
        } else {
          merged.push(fact);
          seen.set(key, merged.length - 1);
        }
      }
      merged.sort((a, b) => b.score - a.score || (a.timestamp < b.timestamp ? 1 : -1));
      (data as unknown as { facts: SemanticFact[] }).facts = merged.slice(0, MEMORY_MAX_FACTS);
    });
  }

  upsertProcedures(procedures: ReadonlyArray<ProceduralMemory>): void {
    if (procedures.length === 0) return;
    this.mutate((data) => {
      const merged = [...data.procedures];
      const keyOf = (p: ProceduralMemory) =>
        `${p.kind}|${p.label.toLowerCase()}|${p.topic ?? ""}`;
      const seen = new Map<string, number>();
      merged.forEach((p, index) => seen.set(keyOf(p), index));
      for (const proc of procedures) {
        const key = keyOf(proc);
        const existing = seen.get(key);
        if (existing !== undefined) {
          merged[existing] = {
            ...merged[existing],
            score: Math.max(merged[existing].score, proc.score),
            timestamp: proc.timestamp,
          };
        } else {
          merged.push(proc);
          seen.set(key, merged.length - 1);
        }
      }
      merged.sort((a, b) => b.score - a.score || (a.timestamp < b.timestamp ? 1 : -1));
      (data as unknown as { procedures: ProceduralMemory[] }).procedures = merged.slice(
        0,
        MEMORY_MAX_PROCEDURES,
      );
    });
  }

  /** Synchronous, atomic (tmp+rename) flush — call at end of a run. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeNow();
  }

  // --- internals ----------------------------------------------------------

  private load(): MemoryLayers {
    try {
      ensureDir();
      if (!fs.existsSync(this.filePath)) return seedData();
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as MemoryLayers;
      if (!parsed || !Array.isArray(parsed.runs)) return seedData();
      return {
        version: 1,
        runs: parsed.runs ?? [],
        facts: parsed.facts ?? [],
        procedures: parsed.procedures ?? [],
      };
    } catch {
      return seedData();
    }
  }

  private mutate(fn: (data: MemoryLayers) => void): void {
    try {
      fn(this.data);
    } catch {
      return;
    }
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeNow();
    }, 250);
    if (typeof this.saveTimer.unref === "function") this.saveTimer.unref();
  }

  private writeNow(): void {
    try {
      ensureDir();
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch {
      /* ignore */
    }
  }
}

let memoryStoreSingleton: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  return (memoryStoreSingleton ??= new MemoryStore());
}

export function resetMemoryStoreSingleton(): void {
  memoryStoreSingleton = null;
}