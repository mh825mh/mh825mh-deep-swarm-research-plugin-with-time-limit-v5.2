/**
 * @file researcher.ts
 * Top-level entry point for the deep research engine.
 * Connects the swarm orchestrator to the report builder.
 */

import { runSwarm } from "./swarm/orchestrator";
import { buildReport } from "./report/builder";
import { ResearchConfig, ResearchResult, StatusFn, WarnFn } from "./types";
import { getDepthProfile } from "./constants";

/**
 * Runs a complete deep research session using the swarm architecture.
 */
export async function runDeepResearch(
  cfg: ResearchConfig,
  status: StatusFn,
  warn: WarnFn,
  signal: AbortSignal,
): Promise<ResearchResult> {
  const profile = getDepthProfile(cfg.depthPreset);

  if (cfg.enableLocalSources) {
    const scope = cfg.localLibraryIds?.length
      ? `${cfg.localLibraryIds.length} selected local librar${cfg.localLibraryIds.length === 1 ? "y" : "ies"}`
      : "all indexed local libraries";

    status(`Local Document Sources enabled: searching ${scope}.`);
  }

  const swarmResult = await runSwarm(cfg, profile, status, warn, signal);

  if (signal.aborted && swarmResult.sources.length === 0) {
    return {
      report: {
        markdown: "Research was cancelled before any sources were collected.",
        sources: [],
        topicKeywords: [],
        coveredDims: [],
        gapDims: [],
        contradictions: [],
      },
      queriesUsed: swarmResult.queriesUsed,
      totalSources: 0,
      totalRounds: 0,
    };
  }

  status("\nBuilding research report…");

    const report = await buildReport(
    cfg.topic,
    swarmResult.sources,
    swarmResult.queriesUsed,
    swarmResult.topicKeywords,
    profile.depthRounds,
    swarmResult.usedAI,
    cfg.enableAIPlanning,
    status,
    profile,
    cfg.contextBudgetMode ?? "auto",
    cfg.manualContextLimit ?? 8192,
    cfg.maxSynthesisInputTokens ?? 18000
  );

  status(
    `Report ready - ${swarmResult.sources.length} sources, ${swarmResult.queriesUsed.length} queries`,
  );

  const footer = buildRunFooter(swarmResult.runStats, swarmResult.workerErrors.length, swarmResult.sources.length, swarmResult.queriesUsed.length);
  const finalMarkdown = footer
    ? `${report.markdown.trim()}\n\n${footer}`
    : report.markdown;

  return {
    report: { ...report, markdown: finalMarkdown },
    queriesUsed: swarmResult.queriesUsed,
    totalSources: swarmResult.sources.length,
    totalRounds: profile.depthRounds,
  };
}

function buildRunFooter(
  stats: Readonly<NonNullable<import("./swarm/orchestrator").OrchestratorResult["runStats"]>> | undefined,
  workerErrorCount: number,
  sourceCount: number,
  queryCount: number,
): string {
  if (!stats) return "";
  const elapsedMin = Math.round(stats.runtimeElapsedMs / 60000);
  const lines: string[] = [
    "---",
    "## 🔍 Query Log",
    `Sources collected: ${sourceCount}`,
    `Queries run: ${queryCount}`,
    `Worker errors: ${workerErrorCount}`,
    "",
    "## 🚦 Source Health",
    `DDG state: ${stats.ddgState}`,
    `DDG searches attempted: ${stats.ddgQueries}`,
    `DDG blocks/challenges: ${stats.ddgBlocks}`,
    "",
    "## 🤖 LLM Watchdog",
    `LLM calls used: ${stats.llmCallsUsed} / ${stats.llmCallBudget}`,
    `Runtime: ${elapsedMin} min`,
    "",
    "## 💾 Cache & Archives",
    `Visited cache entries: ${stats.cacheEntries} (max age ${stats.cacheMaxAgeDays} days)`,
    `Cache file: ${stats.cacheFile}`,
    `Pages archived to Wayback: ${stats.pagesArchived}`,
    `Archive submission failures: ${stats.archiveSubmitFailures}`,
  ];
  return lines.join("\n");
}