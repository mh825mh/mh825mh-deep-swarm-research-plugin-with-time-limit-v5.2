// src/synthesis/ai.ts
import { LMStudioClient } from "@lmstudio/sdk";
import { ReportSource, ContradictionEntry, StatusFn, EvidenceCard, ContextBudget } from "../types";
import { logLlmDiagnostics, estimateTokens, preflightSynthesis } from "../utils/tokens";
import {
  DepthProfile,
  AI_SYNTHESIS_TEMPERATURE,
  AI_SYNTHESIS_TIMEOUT_MS,
  CONTRADICTION_SOURCE_CHARS,
  SYSTEM_INSTRUCTIONS,
} from "../constants";

function prepareEvidenceLedger(
  evidence: ReadonlyArray<EvidenceCard>,
  maxTokens: number
): string {
  const sorted = [...evidence].sort((a, b) => {
    const score = { High: 3, Medium: 2, Low: 1 };
    return score[b.confidence] - score[a.confidence];
  });

  const ledger: string[] = [];
  let currentTokens = 0;
  const tokenLimit = maxTokens - 1000;

  for (const card of sorted) {
    const entry = `[${card.id}] (${card.entityType}) ${card.title} - ${card.authorOrHost}
URL: ${card.canonicalUrl}
Tier: ${card.sourceTier} | Confidence: ${card.confidence} | Freshness: ${card.freshness ?? "Unknown"}
Claim: ${card.relevantClaim}
Excerpt: "${card.supportingExcerpt}"`;
    
    const entryTokens = estimateTokens(entry);
    if (currentTokens + entryTokens > tokenLimit) break;

    ledger.push(entry);
    currentTokens += entryTokens;
  }

  return ledger.join("\n\n---\n\n");
}

export async function synthesiseReport(
  topic: string,
  evidence: ReadonlyArray<EvidenceCard>,
  coveredClaims: ReadonlyArray<string>,
  gapClaims: ReadonlyArray<string>,
  status: StatusFn,
  budget: ContextBudget,
): Promise<string | null> {
  if (evidence.length === 0) return null;

  status(`AI synthesis - preparing evidence ledger (${evidence.length} cards, budget: ${budget.maxSynthesisInput} tokens)…`);

      const evidenceBlock = prepareEvidenceLedger(evidence, budget.maxSynthesisInput);
  const prompt = `You are an expert research analyst. Write a comprehensive, well-structured narrative synthesis of these research findings.

TOPIC: "${topic}"
CLAIMS COVERED: ${coveredClaims.join(", ")}

EVIDENCE LEDGER (Tier A & B only):
 ${evidenceBlock}

STRICT OUTPUT RULES:
1. You MUST start with a Markdown table of recommended sources with these exact columns:
   | Recommendation | Why it fits | Official verification | Independent validation | Status |
2. Only include sources with Verification Tier A or Tier B in the main recommendations.
3. Place Tier C sources in a separate "Other Candidates" appendix at the bottom.
4. Do NOT make generic claims like "All sources are authoritative" or "97% confidence".
5. Only make claims explicitly supported by the Evidence Ledger records.
6. If entity metadata (ISBN, host, edition) is missing, state "Metadata incomplete" rather than guessing.
7. For books, prefer current editions. Label older foundational titles as "foundational".
8. For podcasts, require a current official page or episode within the last 12 months. Label inactive podcasts as "inactive".


SYNTHESIS:`;

  const promptTokens = estimateTokens(prompt);
  const preflight = preflightSynthesis(promptTokens, budget);

  status(`[TOKEN PREFLIGHT] Projected: ${preflight.projectedTotal}/${budget.modelContextLimit} | Decision: ${preflight.decision}`);

  if (preflight.decision === "FAIL-SAFE") {
    status("SYNTHESIS_SKIPPED_CONTEXT_RISK");
    return null;
  }

  logLlmDiagnostics("synthesiseReport", prompt);

  try {
    const client = new LMStudioClient();
    const models = await Promise.race<Awaited<ReturnType<typeof client.llm.listLoaded>>>([
      client.llm.listLoaded(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), AI_SYNTHESIS_TIMEOUT_MS)),
    ]);

    if (!Array.isArray(models) || models.length === 0) return null;
    const model = await client.llm.model(models[0].identifier);

    const stream = model.respond(
      [
        { role: "system", content: SYSTEM_INSTRUCTIONS },
        { role: "user", content: prompt },
      ],
      {
        maxTokens: budget.outputReserve,
        temperature: AI_SYNTHESIS_TEMPERATURE,
      }
    );

    let result = "";
    for await (const chunk of stream) result += chunk.content ?? "";

    if (result.length > 100) {
      status(`AI synthesis complete (${result.length} chars)`);
      return result;
    }
    return null;
  } catch (err) {
    status(`AI synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function detectContradictions(
  topic: string,
  sources: ReadonlyArray<ReportSource>,
  status: StatusFn,
  profile: DepthProfile,
): Promise<ReadonlyArray<ContradictionEntry>> {
  if (sources.length < 3) return [];

  status("Checking for cross-source contradictions...");

  const sourceBlock = sources.slice(0, profile.contradictionMaxSources).map((s) => {
    const preview = s.text.slice(0, CONTRADICTION_SOURCE_CHARS).replace(/\n+/g, " ").trim();
    return `[${s.index}] "${s.title}" - ${s.tier}\n${preview}`;
  }).join("\n\n");

  const maxContradictions = Math.min(10, Math.max(5, Math.floor(sources.length / 5)));

  const prompt = `You are a fact-checking analyst. Given these research sources on "${topic}", identify any CONTRADICTIONS.
SOURCES:
 ${sourceBlock}

For each contradiction, output ONE line:
CLAIM: <claim> | SOURCE_A: [<index>] <stance> | SOURCE_B: [<index>] <stance> | SEVERITY: <minor/moderate/major>

If none, output: NONE
Max ${maxContradictions} contradictions.
OUTPUT:`;

  try {
    const client = new LMStudioClient();
    const models = await client.llm.listLoaded();
    if (!models || models.length === 0) return [];
    const model = await client.llm.model(models[0].identifier);
    
    const stream = model.respond(
      [{ role: "user", content: prompt }],
      { maxTokens: 1500, temperature: 0.15 }
    );

    let raw = "";
    for await (const chunk of stream) raw += chunk.content ?? "";

    if (!raw || /^NONE$/im.test(raw.trim())) return [];

    const entries: ContradictionEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("CLAIM:")) continue;
      try {
        const claimMatch = /CLAIM:\s*(.+?)\s*\|/.exec(trimmed);
        const sourceAMatch = /SOURCE_A:\s*\[(\d+)\]\s*(.+?)\s*\|/.exec(trimmed);
        const sourceBMatch = /SOURCE_B:\s*\[(\d+)\]\s*(.+?)\s*\|/.exec(trimmed);
        const sevMatch = /SEVERITY:\s*(minor|moderate|major)/i.exec(trimmed);
        if (!claimMatch || !sourceAMatch || !sourceBMatch) continue;

        const idxA = parseInt(sourceAMatch[1], 10);
        const idxB = parseInt(sourceBMatch[1], 10);
        entries.push({
          claim: claimMatch[1].trim(),
          sourceA: { index: idxA, title: sources.find(s => s.index === idxA)?.title ?? `Source ${idxA}`, stance: sourceAMatch[2].trim() },
          sourceB: { index: idxB, title: sources.find(s => s.index === idxB)?.title ?? `Source ${idxB}`, stance: sourceBMatch[2].trim() },
          severity: (sevMatch?.[1]?.toLowerCase() ?? "minor") as "minor" | "moderate" | "major",
        });
      } catch { continue; }
    }
    return entries;
  } catch {
    return [];
  }
}