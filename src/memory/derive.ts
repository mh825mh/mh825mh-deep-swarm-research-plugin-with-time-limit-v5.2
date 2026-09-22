/**
 * @file memory/derive.ts
 * Layer derivation for the cross-run memory (Part A).
 *
 * After a run finishes we compute three durable layers that a later run on the
 * same topic can recall:
 *
 *   - Episodic: a compact `RunSummary` (this run, id + keywords + what failed).
 *   - Semantic: durable domain-level facts upgradeable to durable memory
 *     (consistently off-topic hosts that we keep failing on).
 *   - Procedural: "mutations that won" — query tokens that co-occurred with
 *     passing ledger cards, promoted as procedure suggestions.
 *
 * This module is deliberately deterministic (no remote calls): it only turns
 * measurable run outcomes into memory rows, so the persistence layer stays
 * cheap, offline, and auditable.
 */

import { MEMORY_MAX_FACTS, MEMORY_MAX_PROCEDURES } from "../constants";
import {
  LedgerSnapshotCard,
  ProceduralMemory,
  RunSummary,
  SemanticFact,
} from "../types";

/** Everything the derive step needs about one finished run. */
export interface RunDerivationInput {
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

function isoNow(): string {
  return new Date().toISOString();
}

function stableId(text: string, salt: string): string {
  let h = 5381;
  const src = `${salt}:${text.toLowerCase()}`;
  for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) | 0;
  return `m-${(h >>> 0).toString(36)}`;
}

/** Episodic layer — a compact, durable record of this completed run. */
export function buildRunSummary(input: RunDerivationInput): RunSummary {
  return {
    runId: input.runId,
    topic: input.topic,
    topicKeywords: [...input.topicKeywords],
    depthPreset: input.depthPreset,
    focusAreas: [...input.focusAreas],
    timestamp: isoNow(),
    queriesUsed: [...input.queriesUsed],
    sourceCount: input.sourceCount,
    engineHits: input.engineHits.map((e) => ({ engine: e.engine, hits: e.hits })),
    failedUrls: [...input.failedUrls],
    failedHosts: [...input.failedHosts],
    ledger: input.ledger.map((c) => ({
      id: c.id,
      claim: c.claim,
      verdict: c.verdict,
      contradiction: c.contradiction,
    })),
    llmCallsUsed: input.llmCallsUsed,
    criticCallsUsed: input.criticCallsUsed,
    runtimeSec: input.runtimeSec,
    usedAI: input.usedAI,
  };
}

/**
 * Semantic layer — durable facts worth remembering across runs. Only facts we
 * can prove from the ledger + the failed-host list get durable rows, so the
 * memory never persists raw model prose.
 */
export function deriveSemanticFacts(
  input: RunDerivationInput,
): ReadonlyArray<SemanticFact> {
  const facts: SemanticFact[] = [];
  const ts = isoNow();
  const seen = new Set<string>();

  // Durable off-topic hosts: a host that both (a) failed this run and (b) has
  // at least one *passing* verdict from another host in the ledger is a real,
  // repeatedly-measured domain fact — promote it so we stop spending queries
  // on it in a future same-topic run.
  for (const host of input.failedHosts) {
    // Only promote a host if some other source passed a card that this run was
    // built around — i.e. the topic clearly had valid content and this host was
    // the odd one out.
    const hasPass = input.ledger.some((c) => c.verdict === "pass");
    if (!hasPass) continue;
    const id = stableId(host, "offtopic");
    if (seen.has(id)) continue;
    seen.add(id);
    facts.push({
      factId: id,
      kind: "offtopic_domain",
      text: `Host ${host} is consistently off-topic for "${input.topic}"; deprioritize it on like topics.`,
      source: host,
      score: 0.9,
      timestamp: ts,
      topic: input.topic,
    });
  }

  return facts.slice(0, MEMORY_MAX_FACTS);
}

/**
 * Procedural layer — winning query tokens. Any token that appears in both a
 * keyword and a passing ledger claim is a "query mutation" that produced
 * accepted evidence, so a future run should try it first.
 */
export function deriveProceduralMemory(
  input: RunDerivationInput,
): ReadonlyArray<ProceduralMemory> {
  const procedures: ProceduralMemory[] = [];
  const ts = isoNow();
  const seen = new Set<string>();

  const winnerTokens = new Map<string, number>();
  for (const card of input.ledger) {
    if (card.verdict !== "pass") continue;
    const tokens = (card.claim || "").toLowerCase().split(/[^a-z0-9_+-]+/);
    for (const t of tokens) {
      if (t.length < 3) continue;
      winnerTokens.set(t, (winnerTokens.get(t) ?? 0) + 1);
    }
  }

  const ranked = [...winnerTokens.entries()].sort((a, b) => b[1] - a[1]);
  for (const [token, count] of ranked.slice(0, MEMORY_MAX_PROCEDURES)) {
    const id = stableId(token, "mutation");
    if (seen.has(id)) continue;
    seen.add(id);
    procedures.push({
      procedureId: id,
      kind: "mutation",
      label: `Repeat token "${token}" when rewriting queries for "${input.topic}".`,
      score: Math.min(0.4 + count * 0.1, 0.95),
      topic: input.topic,
      timestamp: ts,
    });
  }

  return procedures;
}
