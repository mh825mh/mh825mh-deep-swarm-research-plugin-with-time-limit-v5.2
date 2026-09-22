/**
 * @file memory/persist.ts
 * Orchestrator seam: after a run finishes we fold its durable layers back into
 * the layered memory store so a later run on the same topic starts warm.
 *
 * This seam is deliberately cheap + offline + deterministic — it only turns
 * measurable run outcomes into memory rows via derive.ts and hands them to the
 * store's upsert. Best-effort: any failure is swallowed so a memory hiccup can
 * never abort an otherwise-finished research run.
 */

import {
  MEMORY_MAX_FACTS,
  MEMORY_MAX_PROCEDURES,
} from "../constants";
import {
  LedgerSnapshotCard,
  ProceduralMemory,
  RunSummary,
  SemanticFact,
} from "../types";
import { buildRunSummary, deriveSemanticFacts, deriveProceduralMemory } from "./derive";
import { getMemoryStore } from "./store";

/** In-scope run-end facts the persist seam needs. */
export interface PersistRunSeamInput {
  readonly runId: string;
  readonly topic: string;
  readonly topicKeywords: ReadonlyArray<string>;
  readonly depthPreset: string;
  readonly focusAreas: ReadonlyArray<string>;
  readonly queriesUsed: ReadonlyArray<string>;
  readonly sourceCount: number;
  readonly engineHits: ReadonlyArray<{ readonly engine: string; readonly hits: number }>;
  readonly failedUrls: ReadonlyArray<string>;
  readonly failedHosts: ReadonlyArray<string>;
  readonly ledger: ReadonlyArray<LedgerSnapshotCard>;
  readonly llmCallsUsed: number;
  readonly criticCallsUsed: number;
  readonly runtimeSec: number;
  readonly usedAI: boolean;
}

/**
 * Derive (episodic summary + semantic facts + procedural recollection) and
 * upsert all three layers into the durable store. Non-blocking best-effort.
 */
export async function persistRunMemory(input: PersistRunSeamInput): Promise<void> {
  try {
    const store = getMemoryStore();
    const summary: RunSummary = buildRunSummary(input);
    store.addRun(summary);

    const facts: ReadonlyArray<SemanticFact> = deriveSemanticFacts(input);
    if (facts.length > 0) store.upsertFacts(facts.slice(0, MEMORY_MAX_FACTS));

    const procedures: ReadonlyArray<ProceduralMemory> = deriveProceduralMemory(input);
    if (procedures.length > 0) store.upsertProcedures(procedures.slice(0, MEMORY_MAX_PROCEDURES));
  } catch {
    /* best-effort; never let memory persistence abort a finished run */
  }
}
