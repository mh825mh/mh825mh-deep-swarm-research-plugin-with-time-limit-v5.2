// src/config.ts
import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "timeRange",
    "select",
    {
      displayName: "Search Time Range",
      subtitle: "Filter search results by publication date to ensure information freshness.",
      options: [
        { value: "all", displayName: "All time (default)" },
        { value: "year", displayName: "Past year" },
        { value: "month", displayName: "Past month" },
        { value: "week", displayName: "Past week" },
        { value: "day", displayName: "Past 24 hours" },
      ],
    },
    "all",
  )
  .field(
    "researchDepth",
    "select",
    {
      displayName: "Research Depth",
      subtitle:
        "Controls rounds, per-worker budgets, queries, and link-following aggressiveness. " +
        "Sources are collected adaptively with no hard cap — deeper = more sources.",
      options: [
        { value: "shallow", displayName: "Shallow — 1 round, ~10-25 sources, fast" },
        { value: "standard", displayName: "Standard — 3 rounds, ~30-60 sources (recommended)" },
        { value: "deep", displayName: "Deep — 5 rounds, ~60-120 sources, thorough" },
        { value: "deeper", displayName: "Deeper — 10 rounds, ~100-200+ sources, very thorough" },
        { value: "exhaustive", displayName: "Exhaustive — 15 rounds, 200+ sources, maximum depth" },
      ],
    },
    "standard",
  )
  .field(
    "engineSelectionMode",
    "select",
    {
      displayName: "Engine Selection Mode",
      subtitle:
        "Controls how search engines are chosen per worker. " +
        "Adaptive: DDG first, fallbacks if weak. " +
        "Benchmark: Run all engines to test performance. " +
        "Priority: Use best engines from historical data.",
      options: [
        { value: "adaptive", displayName: "Adaptive (Default)" },
        { value: "benchmark", displayName: "Benchmark (Run all)" },
        { value: "priority", displayName: "Priority (Historical)" },
      ],
    },
    "adaptive",
  )
  .field(
    "cacheDuration",
    "select",
    {
      displayName: "Persistent Cache Duration",
      subtitle: "How long visited pages and extracted content are kept in the local cache.",
      options: [
        { value: "30", displayName: "30 Days" },
        { value: "90", displayName: "90 Days" },
        { value: "180", displayName: "6 Months" },
        { value: "365", displayName: "12 Months" },
        { value: "730", displayName: "24 Months" },
      ],
    },
    "30",
  )
  .field(
    "contentLimitPerPage",
    "numeric",
    {
      displayName: "Content Per Page (chars)",
      subtitle:
        "Characters extracted per page. Higher = richer but slower. " +
        "Leave at default to auto-scale with depth preset (1000-20000)",
      min: 1000,
      max: 20000,
      int: true,
      slider: { step: 1000, min: 1000, max: 20000 },
    },
    4000,
  )
  .field(
    "enableLinkFollowing",
    "select",
    {
      displayName: "Link Following",
      subtitle: "Workers follow relevant in-page links (like citations and references)",
      options: [
        { value: "on", displayName: "On — follow top links (recommended)" },
        { value: "off", displayName: "Off — search results only" },
      ],
    },
    "on",
  )
  .field(
    "enableAIPlanning",
    "select",
    {
      displayName: "AI Query Planning",
      subtitle: "Use the loaded model for smarter queries, dynamic decomposition, and synthesis",
      options: [
        { value: "on", displayName: "On — AI-powered (best quality)" },
        { value: "off", displayName: "Off — dimension-based fallback (faster start)" },
      ],
    },
    "on",
  )
  .field(
    "safeSearch",
    "select",
    {
      displayName: "Safe Search",
      options: [
        { value: "strict", displayName: "Strict" },
        { value: "moderate", displayName: "Moderate" },
        { value: "off", displayName: "Off" },
      ],
    },
    "moderate",
  )
  .field(
    "enableLocalSources",
    "select",
    {
      displayName: "Data Sources",
      subtitle: "Choose where the research swarm should pull information from.",
      options: [
        { value: "off", displayName: "Web only" },
        { value: "local", displayName: "Local documents only" },
        { value: "web_local", displayName: "Local documents and web" },
      ],
    },
    "off",
  )
  .field(
    "maxSessionMinutes",
    "numeric",
    {
      displayName: "Max Session Time (minutes)",
      subtitle:
        "Hard cap on wall-clock time for Deep Research runs. " +
        "Set to 0 for Unlimited (runs until exhausted or stagnates).",
      min: 0,
      max: 240,
      int: true,
      slider: { step: 5, min: 0, max: 240 },
    },
    30,
  )
  .field(
    "enableAcademicAPIs",
    "select",
    {
      displayName: "Academic APIs (OpenAlex, Crossref, arXiv)",
      subtitle: "Query academic databases directly for papers and research.",
      options: [
        { value: "on", displayName: "On" },
        { value: "off", displayName: "Off" },
      ],
    },
    "off",
  )
  .field(
    "enableYouTube",
    "select",
    {
      displayName: "YouTube Transcript Search",
      subtitle: "Search YouTube and extract video transcripts as text sources.",
      options: [
        { value: "on", displayName: "On" },
        { value: "off", displayName: "Off" },
      ],
    },
    "off",
  )
  .field(
    "enableReferenceSearch",
    "select",
    {
      displayName: "Encyclopedia Search",
      subtitle: "Prioritize Grokipedia, Encyclopedia.com, and Britannica over Wikipedia.",
      options: [
        { value: "on", displayName: "On" },
        { value: "off", displayName: "Off" },
      ],
    },
    "on",
  )
    .field(
    "contextBudgetMode",
    "select",
    {
      displayName: "Context Budget Mode",
      subtitle: "Controls how the plugin manages token limits for synthesis. Auto is recommended.",
      options: [
        { value: "auto", displayName: "Auto (Recommended)" },
        { value: "conservative", displayName: "Conservative" },
        { value: "manual", displayName: "Manual Override" },
      ],
    },
    "auto",
  )
  .field(
    "manualContextLimit",
    "numeric",
    {
      displayName: "Manual Context Limit (Tokens)",
      subtitle: "Only used if Mode is Manual. E.g., 8192, 16384, 32768.",
      min: 2048,
      max: 131072,
      int: true,
    },
    8192,
  )
  .field(
    "maxSynthesisInputTokens",
    "numeric",
    {
      displayName: "Max Synthesis Input Tokens",
      subtitle: "Hard cap on tokens sent to the model for final report generation.",
      min: 2000,
      max: 32000,
      int: true,
    },
    18000,
  )
    .field(
    "contextIsolation",
    "select",
    {
      displayName: "LLM Context Isolation",
      subtitle: "Controls how model context is managed. Strict isolation prevents context overflow and history bleed.",
      options: [
        { value: "strict", displayName: "Strict isolation (Recommended)" },
        { value: "worker_reuse", displayName: "Reuse within one worker only" },
        { value: "advanced_reuse", displayName: "Advanced reuse (Not recommended)" },
      ],
    },
    "strict",
  )
  .field(
    "llmCallMode",
    "select",
    {
      displayName: "LLM Call Budget",
      subtitle: "Hard limit on model calls to prevent infinite loops. Standard is highly recommended.",
      options: [
        { value: "compact", displayName: "Compact (Max 20 calls)" },
        { value: "standard", displayName: "Standard (Max 45 calls)" },
        { value: "deep", displayName: "Deep (Max 80 calls)" },
        { value: "extended", displayName: "Extended (Max 120 calls)" },
      ],
    },
    "standard",
  )
  // Add this right BEFORE the final .build()
  .field(
    "flaresolverrUrl",
    "string",
    {
      displayName: "FlareSolverr URL (Advanced)",
      subtitle: "Optional: Local endpoint to bypass strict Cloudflare blocks (e.g., http://127.0.0.1:8191/v1). Leave blank to disable.",
    },
    ""
  )  
  .build();