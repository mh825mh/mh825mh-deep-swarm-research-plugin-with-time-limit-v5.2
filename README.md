# 🐝 Deep Research w/ Swarm Agent (v5.3.2)

Autonomous deep research for LM Studio. A swarm of specialized AI workers searches your local documents and the web, dynamically adapting its strategy, resolving contradictions, and synthesizing everything into a structured, confidence-scored report—all in one tool call.

## 🚀 What's New in v5.3.x?

This release introduces an enterprise-grade fail-safe architecture, completely eliminating context-overflow crashes, infinite LLM loops, and search-engine IP bans.

**🛡️ The Unbreakable Search Engine (Waterfall Fetcher)**
*   **Tier A (got-scraping):** Native TLS fingerprinting bypasses 80% of passive Cloudflare blocks.
*   **Tier B (FlareSolverr):** Optional advanced UI toggle to route aggressive JS challenges through a local headless browser.
*   **Tier C (Wayback Machine):** If a website blocks the plugin with a 403 or Captcha, it automatically falls back to cache archives so research never stalls.
*   **Tri-Mode Engine Routing:** Choose between Adaptive (fallback on failure), Benchmark (test all engines), or Priority (historical bests). 

**🧠 Adaptive Context Budget & Watchdog**
*   **No More Context Crashes:** Dynamically calculates safe token limits. It uses a strict Evidence Ledger (compact 120-token cards) instead of raw text, enforcing a hard 18,000-token synthesis ceiling.
*   **LLM Call Budget & Stall Detection:** Hard caps on model calls (Standard = 45 calls) prevent infinite loops. A 2-minute stall watchdog safely cancels hung runs and outputs a partial report.

**✅ Verification Tiers & File Logging**
*   **4-Tier Verification:** Sources are sorted into Tiers A (Canonically verified), B (Independently validated), C (Relevant candidate), and REJECTED. 
*   **Deterministic Health Reports:** Every run generates a timestamped `.txt` log file in `~/.deep-swarm-research/logs/` with search attribution and watchdog metrics.

---

## 📦 Installation & Setup

**1. API Keys Setup (Optional but Recommended)**
The plugin works perfectly using free scraping (DDG/Brave/SearXNG), but you can optionally use premium APIs for fast, reliable gap-filling.
Run the plugin once to auto-generate the keys file at:
*   **Windows:** `C:\Users\<you>\.deep-swarm-research\api-keys.json`
*   **macOS/Linux:** `~/.deep-swarm-research/api-keys.json`

```json
{
  "serperApiKey": "YOUR_SERPER_KEY",
  "braveApiKey": "YOUR_BRAVE_KEY"
}

2. Local Document Sources (RAG)Want the swarm to research your proprietary files alongside the web?Use the RAG Add Library tool to index a local folder.In the LM Studio plugin settings, change Data Sources to Local documents and web (or Local only).🛠️ Available ToolsResearch & WebDeepResearch: The main tool. Give it a topic, get back a full Markdown report with AI analysis, citations, contradiction detection, and 12-dimension coverage.Search: Scored web results with domain authority tiers.Read Page / Multi-Read: Fetch and extract up to 10 URLs concurrently. Handles PDFs automatically.Local Library & RAGRAG Add / List / Remove: Manage indexed local folders with priority tiers (proprietary, internal, reference, general).RAG Search: Search libraries using BM25 + fuzzy n-gram hybrid scoring.RAG Check Changes: Detect modified, deleted, or new files.RAG Save / Load Index: Persist the index to disk for instant access next session.🧠 How It Works (The Fail-Safe Agentic Loop)Decomposition: Breaks the topic into up to 10 specialized worker roles (academic, regulatory, statistical, etc.).Mandatory Local Layer: The swarm ALWAYS searches local RAG libraries first. If local evidence is sufficient, it skips the web entirely.Gap-Driven Web Search: External searches are driven strictly by missing dimensions (gaps). Free engines are used first; paid APIs are held in reserve.Anti-Block Fetching: Pages are fetched using the new Waterfall Strategy. If blocked, it seamlessly falls back to FlareSolverr or web archives.Evidence Ledger: Workers extract compact "Evidence Cards" sorted into 4 Verification Tiers.Watchdog: A strict call budget and stall detector prevent infinite loops.Synthesis: The LLM writes a narrative report in an isolated context, guaranteeing no overflow.Progressive Source ApproachFor organizations with large datalakes, the plugin searches in priority order:Plaintext┌─────────────────────┐
│  1. PROPRIETARY      │  < Confidential data (contracts, internal memos)
│     Searched first   │
├─────────────────────┤
│  2. INTERNAL         │  < Shared team knowledge (wikis, documentation)
│     Searched second  │
├─────────────────────┤
│  3. REFERENCE        │  < Curated reference materials (papers, standards)
│     Searched third   │
├─────────────────────┤
│  4. GENERAL          │  < Miscellaneous local documents
│     Searched fourth  │
├─────────────────────┤
│  5. WEB              │  < Public internet (fills remaining gaps)
│     Searched last    │
└─────────────────────┘
📊 Depth PresetsShallowStandardDeepDeeperExhaustiveRounds1351015Worker roles5581010Pages/worker58121825Search engines12345Link depth11223Content/page5K6K8K12K16KMax Sources~50~80~150~250+~400+⚙️ Configuration (LM Studio UI)SettingDescriptionData SourcesWeb only, Local documents only, or Local documents and web.Research DepthShallow -> Exhaustive. Controls rounds and budgets.Engine Selection ModeAdaptive, Benchmark, or Priority.Context Budget ModeAuto (Recommended). Dynamically scales token limits.LLM Call BudgetStandard (Max 45 calls). Prevents infinite loops.LLM Context IsolationStrict isolation. Prevents history bleed.Max Session TimeHard cap on wall-clock time (minutes).Academic APIsQuery OpenAlex, Crossref, and arXiv directly for papers.YouTube SearchEnable YouTube scraping and transcript extraction.FlareSolverr URLAdvanced: Local endpoint for Cloudflare bypass (e.g., http://127.0.0.1:8191/v1).📜 Changelogv5.3.2 - Multi-tier waterfall fetcher, FlareSolverr Cloudflare bypass, DOM parser crash fix, and AI query planner overhaul.v5.3.1 - Enterprise-grade fail-safe architecture, Watchdog, Context Budget, and Verification Tiers.v5.2.1 - Multi-API, Tri-Mode Engines (Adaptive/Benchmark/Priority), & YouTube transcripts.v5.2.0 - AI-Driven Query Mutation & Anti-Block Upgrades.v5.1 - Native Engine Time Filtering & Architecture.v5.0 - Failure Memory & State Tracking.v4.0 - Session Timeouts.v3.0 & v1.0 - Initial Swarm & Wall-Clock Limits.🗣️ Recommended System PromptsFor 14B+ ModelsPlaintextYou are an expert Deep Research Analyst. Your goal is to synthesize complex information from local proprietary databases and the public web into highly structured, objective, and rigorously cited reports.

TOOL INVOCATION RULES
When a user asks for research, analysis, comparisons, or deep dives, you MUST use the "DeepResearch" tool. 
- Use focusAreas to break down complex prompts into specific angles.
- Use depthOverride to control the breadth of the research.

POST-RESEARCH SYNTHESIS FRAMEWORK
When the tool returns the research report, structure your response exactly as follows:
1. Executive Summary: A concise, 3-4 sentence TL;DR.
2. Core Analysis: Detailed synthesis organized by theme, NOT by source.
3. Source Origin & Temporal Context: Note if findings rely on Local vs. Web data, and the time period.
4. Contradictions & Nuance: Highlight conflicting sources objectively.
5. Coverage Gaps & Next Steps: Identify missing info and suggest follow-ups.

STRICT CITATION & CONFIDENCE RULES
- You MUST cite every factual claim using the exact index format provided by the tool: [1], [2], etc.
- NEVER invent, guess, or hallucinate citation numbers. 
- If the tool provides [High/Medium/Low Confidence] tags, preserve them.
- Prioritize proprietary/internal sources over web sources when they conflict.

TONE & STYLE
- Maintain a highly professional, objective, and analytical tone.
- Avoid filler phrases like "Based on the research provided..." Just deliver the analysis directly.
- Use Markdown formatting (bolding, lists, tables) to make dense information highly readable.
Compact System Prompt (For 7B - 8B models)PlaintextYou are an expert Research Analyst. Use the "Deep Research" tool for any complex query, setting `depthOverride` based on complexity.

When the tool returns results, format your response exactly like this:
1. **Executive Summary**: 3-sentence TL;DR.
2. **Detailed Analysis**: Synthesize by theme, not by source. 
3. **Source Context**: Note if findings rely on Local/Proprietary docs vs Web, and note the time period.
4. **Contradictions**: Highlight conflicting sources objectively.
5. **Gaps**: What is missing? Suggest follow-ups.

STRICT RULES:
- Cite EVERY claim using the tool's exact numbers: [1], [2], etc. NEVER hallucinate citation numbers.
- Prioritize Local/Proprietary sources over Web sources.
- Do not use filler phrases. Be direct, objective, and use Markdown tables/lists for readability.
📄 LicenseMIT License