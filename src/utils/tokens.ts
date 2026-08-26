const EST_CHARS_PER_TOKEN = 4;
export const MAX_LLM_INPUT_TOKENS = 24000;

import { ContextBudget } from "../types";

export function calculateContextBudget(
  mode: "auto" | "conservative" | "manual",
  manualLimit: number,
  maxSynthesisInputSetting: number,
  detectedModelLimit: number = 8192
): ContextBudget {
  let modelContextLimit = detectedModelLimit;

  if (mode === "manual") {
    modelContextLimit = manualLimit;
  } else if (mode === "conservative") {
    modelContextLimit = Math.min(detectedModelLimit, 8192);
  }

  const outputReserve = Math.max(1024, Math.min(8192, Math.floor(modelContextLimit * 0.12)));
  const safetyMargin = Math.max(1024, Math.floor(modelContextLimit * 0.10));
  
  let maxSynthesisInput = Math.min(
    Math.floor(modelContextLimit * 0.55),
    modelContextLimit - outputReserve - safetyMargin,
    maxSynthesisInputSetting
  );

  if (mode === "conservative") {
    maxSynthesisInput = Math.min(maxSynthesisInput, 4500);
  }

  maxSynthesisInput = Math.max(2048, maxSynthesisInput);

  return {
    mode,
    modelContextLimit,
    outputReserve,
    safetyMargin,
    maxSynthesisInput,
  };
}

export interface PreflightResult {
  readonly decision: "ALLOW" | "COMPACT" | "FAIL-SAFE";
  readonly projectedTotal: number;
  readonly budget: ContextBudget;
}

export function preflightSynthesis(
  promptTokens: number,
  budget: ContextBudget
): PreflightResult {
  const projectedTotal = promptTokens + budget.outputReserve + budget.safetyMargin;
  const pct = projectedTotal / budget.modelContextLimit;

  if (pct > 0.95) {
    return { decision: "FAIL-SAFE", projectedTotal, budget };
  } else if (pct > 0.85) {
    return { decision: "COMPACT", projectedTotal, budget };
  } else {
    return { decision: "ALLOW", projectedTotal, budget };
  }
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / EST_CHARS_PER_TOKEN);
}

export function truncateToTokenLimit(
  texts: string[],
  maxTokens: number = MAX_LLM_INPUT_TOKENS
): { truncated: string[]; totalTokens: number; cutOff: boolean } {
  const truncated: string[] = [];
  let totalTokens = 0;
  let cutOff = false;

  for (const text of texts) {
    const tokens = estimateTokens(text);
    if (totalTokens + tokens > maxTokens) {
      // Calculate remaining space and slice the text to fit
      const remainingTokens = maxTokens - totalTokens;
      if (remainingTokens > 100) { // Only add if we have at least 100 tokens of space left
        const sliceChars = remainingTokens * EST_CHARS_PER_TOKEN;
        truncated.push(text.slice(0, sliceChars) + "\n[...TRUNCATED...]");
        totalTokens += remainingTokens;
      }
      cutOff = true;
      break;
    }
    truncated.push(text);
    totalTokens += tokens;
  }

  return { truncated, totalTokens, cutOff };
}

export function logLlmDiagnostics(funcName: string, inputText: string) {
  const tokens = estimateTokens(inputText);
  const status = tokens > MAX_LLM_INPUT_TOKENS ? "⚠️ OVER LIMIT" : "✅ OK";
  console.log(`[LLM DIAG] Func: ${funcName} | Est. Tokens: ${tokens} | ${status}`);
  return tokens;
}