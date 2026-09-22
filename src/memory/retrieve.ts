/**
 * @file memory/retrieve.ts
 * Same-topic re-entry retrieval. Before a new run commits to its query
 * decomposition, we look up what the layered memory store already knows about
 * this topic and shape it into a compact `MemoryContext` that feeds the run
 * bootstrap — so a re-run starts from what the first run learned instead of
 * cold.
 *
 * Pure-local + deterministic: BM25 / keyword-overlap over the persisted
 * layers only. No remote calls, so re-entry never blocks on the AI stack.
 */

import {
  MEMORY_CONTEXT_MAX_CHARS,
  MEMORY_RECALL_FACTS,
  MEMORY_RECALL_FAILED_HOSTS,
  MEMORY_RECALL_FAILED_URLS,
  MEMORY_RECALL_GOOD_ENGINES,
  MEMORY_RECALL_PROCEDURES,
  MEMORY_RECALL_RUNS,
  MEMORY_TOPIC_MIN_SIM,
} from "../constants";
import {
  MemoryContext,
  ProceduralMemory,
  RunSummary,
  SemanticFact,
} from "../types";
import {
  getMemoryStore,
  keywordOverlapMemory,
  rankMemoryByBM25,
  RankableMemory,
} from "./store";

function runDoc(run: RunSummary): RankableMemory {
  const focus = run.focusAreas.length > 0 ? run.focusAreas.join(" ") : "";
  return {
    id: run.runId,
    text: `${run.topic} ${run.topicKeywords.join(" ")} ${focus}`.trim(),
  };
}

function factDoc(fact: SemanticFact): RankableMemory {
  return { id: fact.factId, text: `${fact.topic ?? ""} ${fact.text}`.trim() };
}

function procedureDoc(proc: ProceduralMemory): RankableMemory {
  return { id: proc.procedureId, text: `${proc.topic ?? ""} ${proc.label}`.trim() };
}

export interface RetrieveMemoryOptions {
  readonly topic: string;
  readonly topicKeywords: ReadonlyArray<string>;
  readonly topN?: number;
  readonly minSim?: number;
}

/**
 * Fetch the layered context most relevant to a (re)entered topic. Returns an
 * effectively-empty context when nothing durable matches, so a fresh topic
 * never carries stale baggage.
 */
export function retrieveMemoryForTopic(
  options: RetrieveMemoryOptions,
): MemoryContext {
  const store = getMemoryStore();
  const runs = store.runs();
  const facts = store.facts();
  const procedures = store.procedures();

  const query = `${options.topic} ${options.topicKeywords.join(" ")}`.trim();
  const topN = options.topN ?? MEMORY_RECALL_RUNS;
  const minSim = options.minSim ?? MEMORY_TOPIC_MIN_SIM;

  const topRuns = rankMemoryByBM25(query, runs.map(runDoc), Math.min(topN, runs.length))
    .filter((c) => c.score > minSim)
    .map((c) => runs.find((r) => r.runId === c.id))
    .filter((r): r is RunSummary => !!r);

  const topFacts = rankMemoryByBM25(
    query,
    facts.map(factDoc),
    Math.min(MEMORY_RECALL_FACTS, facts.length),
  )
    .filter((c) => c.score > minSim * 0.5)
    .map((c) => facts.find((f) => f.factId === c.id))
    .filter((f): f is SemanticFact => !!f);

  const topProcedures = rankMemoryByBM25(
    query,
    procedures.map(procedureDoc),
    Math.min(MEMORY_RECALL_PROCEDURES, procedures.length),
  )
    .filter((c) => c.score > minSim * 0.5)
    .map((c) => procedures.find((p) => p.procedureId === c.id))
    .filter((p): p is ProceduralMemory => !!p);

  const goodEngines = new Set<string>();
  const failedUrls = new Set<string>();
  const failedHosts = new Set<string>();
  for (const run of topRuns) {
    for (const e of run.engineHits) if (e.hits > 0) goodEngines.add(e.engine);
    for (const u of run.failedUrls) failedUrls.add(u);
    for (const h of run.failedHosts) failedHosts.add(h);
  }

  // Keyword-overlap boost against the whole episodic layer, so a couple of
  // high-signal hints that BM25 under-weights for very short topics surface.
  const overlapHints: Array<{ id: string; text: string }> = [];
  for (const run of runs) {
    if (topRuns.some((r) => r.runId === run.runId)) continue;
    if (keywordOverlapMemory(query, `${run.topic} ${run.topicKeywords.join(" ")}`) > 0.55) {
      overlapHints.push({ id: run.runId, text: run.topic });
    }
  }
  const extraRuns = overlapHints
    .slice(0, Math.max(0, topN - topRuns.length))
    .map((h) => runs.find((r) => r.runId === h.id))
    .filter((r): r is RunSummary => !!r);

  for (const run of extraRuns) {
    for (const e of run.engineHits) if (e.hits > 0) goodEngines.add(e.engine);
    for (const u of run.failedUrls) failedUrls.add(u);
    for (const h of run.failedHosts) failedHosts.add(h);
  }

  const selected = [...topRuns, ...extraRuns];
  const budget = MEMORY_CONTEXT_MAX_CHARS - query.length * 4;
  let used = 0;

  const runTexts: Array<{ id: string; text: string }> = [];
  for (const run of selected) {
    if (used >= budget) break;
    const t = `${run.topic} :: ${run.focusAreas.join(", ")} :: queries: ${run.queriesUsed.join(" | ")}`;
    const delta = t.length + 2;
    if (used + delta > budget && runTexts.length > 0) break;
    used += delta;
    runTexts.push({ id: run.runId, text: t });
  }
  for (const f of topFacts.slice(0, 4)) runTexts.push({ id: f.factId, text: `fact: ${f.text}` });
  for (const p of topProcedures.slice(0, 3)) runTexts.push({ id: p.procedureId, text: `proc: ${p.label}` });

  const cappedRuns = selected.filter((r) => runTexts.some((t) => t.id === r.runId)).slice(0, 4);

  return {
    runs: cappedRuns,
    facts: topFacts.slice(0, 4),
    procedures: topProcedures.slice(0, 3),
    goodEngines: [...goodEngines].slice(0, MEMORY_RECALL_GOOD_ENGINES),
    failedUrls: [...failedUrls].slice(0, MEMORY_RECALL_FAILED_URLS),
    failedHosts: [...failedHosts].slice(0, MEMORY_RECALL_FAILED_HOSTS),
    ranker: "bm25",
  };
}
