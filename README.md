# 🐝 Deep Research w/ Swarm Agent (v5.5.1)



Autonomous deep research for LM Studio. A swarm of specialized AI workers searches your local documents and the web, dynamically adapting its strategy, verifying claims, and synthesizing everything into a structured, confidence-scored report with auditable citations—all in one tool call.

## 🚀 What's New in v5.5.1?

* **Fixed plugin load failure:** `got-scraping` v4 is ESM-only, but LM Studio bundles plugins as CommonJS and requires it externally, which crashed startup with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The waterfall fetcher now loads it lazily via an indirect dynamic `import()`, so the plugin registers cleanly; if the module is ever unavailable the TLS tier is skipped and fetching falls through to FlareSolverr/Wayback. The Wayback tier now uses the built-in `fetch` instead of `got-scraping`.

## 🚀 What's New in v5.5.0?

* **Fixed page-cache persistence:** the visited-page cache no longer lives in a cwd-relative `.cache/` folder (which could be unwritable or reset depending on the working directory). It now lives under `~/.deep-swarm-research/cache/visited-pages-v2.json`, migrates any existing v1 cache once, writes atomically (temp file + rename), debounces saves, and caps itself at 2,000 entries (oldest evicted first). Post-redirect URLs are aliased back to the requested URL so lookups always hit.
* **Negative cache:** URLs that fail to fetch or are decisively off-topic/low-content are remembered for 24h (`isRejected`/`markRejected`) and skipped on subsequent runs, avoiding repeated dead-link retries. A successful fetch clears the negative entry.
* **PDF text extraction:** pages are now extracted from PDFs via `pdf-parse`, so long reports and papers feed real text into extraction instead of being skipped.
* **Real time-limit enforcement:** the session limit now drives a hard wall-clock abort timer (not just a soft crawl deadline), logs the *effective* runtime (`min(session limit, LLM mode cap)`), and shows requested-vs-effective in the run footer. `0` means **no session limit** for crawling while LLM calls stay bounded by the mode budget.
* **Feeds run automatically:** when `rssFeedUrls` / `telegramChannels` are configured, a dedicated feed pass queries them once per run (topic + top planned queries) instead of being limited to benchmark mode; the standalone `Search` tool also includes them by default.
* **Cache visibility:** run footer/logs now report visited + negative-cache entry counts, the cache file path, and negative-cache skips.

## 🚀 What's New in v5.4.0?

* **More results per query:** fixed the volume bug where `multiEngineSearch` divided the requested result count across engines, so 3 engines returned ~3 hits each instead of the full budget. Workers and the standalone `Search` tool now pass a per-engine target (`resultsPerQuery × engineCount`, capped at 20/engine), so every engine contributes its full share before merge/dedupe.
* **Deeper source extraction:** extraction previously stored only the first `contentLimit` characters of each page. Deep presets now stitch multiple chunks of the same document (`extractPagesPerSource`: 1/1/2/2/3 across shallow→exhaustive) into a single richer source, for long articles and multi-page PDFs.
* **Richer `Search` tool:** now queries DuckDuckGo + Bing + reference sites by default (plus OpenAlex/Crossref/arXiv when academic APIs are on, and YouTube when enabled), forwards API keys and recency, and accepts optional `engines` and `timeRange` parameters. Results are still scored/ranked by domain authority, URL quality, and freshness.
* **More detailed reports:** evidence excerpts are now configurable (`evidenceExcerptChars`, preset 300–1000) instead of a hardcoded 120/300-char slice, and the full-source appendix preview was raised from 700 → 1500 chars.
* **New config knobs:** Content Budget Mode (Auto scales per-page chars with depth, or Manual), Results Per Query override (0 = preset), Evidence Excerpt Per Source, and Adaptive Learning on/off.
* **Cross-plugin tools:** a new `Use Plugin Tool` tool lets the model list and invoke tools exposed by *other* loaded LM Studio plugins (`ctl.client.plugins.pluginTools`), so Deep Swarm can pull evidence/capabilities from companion plugins. Configure target plugin ids via the `externalPluginTools` setting; the remote session is always disposed.
* **Real adaptive learning (persistent):** the advertised `priority` engine-selection mode is now implemented, and outcome statistics persist across runs under `~/.deep-swarm-research/` — engine success EMAs now order engines in Priority mode, mutation strategies are ranked by historical acceptance, and domains get a small score adjustment based on accepted/rejected history (after ≥3 samples). When a model is loaded, a final reflection pass distills reusable search-strategy hints that future runs fold into query planning. All of it is heuristic/statistical — no model weights or plugin code are modified — and it can be disabled with the Adaptive Learning toggle.

## 🚀 What's New in v5.3.7?

* **New Bing engine:** keyless HTML scraping with `u=` base64 target decoding. Live-tested: 10/10 result blocks decode into real URLs with snippets. Bing now replaces Google-scrape/Mojeek/Yandex as the second keyless web engine everywhere (worker extra engines, gap fillers, standalone Search tool).
* **YouTube search fixed:** the `youtube` engine no longer scrapes the JS-rendered results page (which only yielded self-links). It now POSTs to `youtubei/v1/search` with the same WEB client the site uses, extracting real video results (title, owner, publish date, duration).
* **Per-engine health gating:** fragile no-key engines (bing, brave, google, scholar, searxng, mojeek, yandex, youtube) now get per-engine health tracking — 3 consecutive empty results trigger an 11-minute cooldown, so dead engines stop burning 4–5s queue slots on every query. Reliable API/reference engines run unconditionally.
* **Dead engines pruned:** removed the dead `search.ononoki.org` searxng endpoint and dropped Mojeek/Yandex/Google-scrape from default profile engine lists.
* **Mutation upgrades:** acceptance scoring is now relevance-aware (title/snippet/URL token overlap with the original query + host diversity, so off-topic mutations can't "win"); the LLM call budget is only charged when a model is actually loaded; accepted mutations are fed back through the extra engines; and mutation hits carry full route attribution.

## 🚀 What's New in v5.3.6?

* **Grokipedia search fixed:** was returning zero results — the plugin used the wrong query param (`?query=` vs the site's `?q=`) and the wrong link selector (`/wiki/` vs the site's actual `/page/<slug>` paths). It now canonicalizes `/page/` links, pulls real snippets, and is properly scored as a reference domain.
* **YouTube transcripts now actually fetch:** YouTube began returning empty caption bodies to anonymous requests, so transcript extraction silently degraded to video descriptions. The extractor now reads `ytInitialPlayerResponse`, extracts the INNERTUBE API key, and calls the `youtubei/v1/player` endpoint (ANDROID client) to obtain a working timedtext URL, with graceful fallback when YouTube requires a proof-of-origin token (`exp=xpe`).
* **YouTube engine reachable in adaptive mode:** `enableYouTube` previously only added the `youtube` engine in benchmark mode; it now also joins `breadth`/`academic` roles in adaptive runs, so transcript sources actually surface.

## 🚀 What's New in v5.3.5?

* **SSRF hardening:** a dedicated, unit-tested SSRF guard now blocks internal/private targets, IPv4-mapped forms, numeric-obfuscated addresses, special-use DNS suffixes (`.local`, `.internal`, `.home.arpa`), and DNS-rebinding attempts before any request is made.
* **Archive-on-failure:** when a page fails every fetch tier, the plugin submits it once per run to the Wayback Machine (`/save/`), writes a local log to `~/.deep-swarm-research/archives.json`, and reports archived pages in the run-health footer.
* **RSS & Telegram feeds:** optional `rssFeedUrls` and `telegramChannels` in `api-keys.json` let workers mine feeds and public channels as extra evidence sources.
* **Run-health footer:** every report now ends with a compact 🔍 Query Log / 🚦 Source Health / 🤖 LLM Watchdog / 💾 Cache & Archives summary (DDG state, LLM calls used, cache entries, archives submitted).
* **Cache duration in days:** the Cache Duration setting is now interpreted as days (default 30) instead of months.
* **Hardened archive fallback list:** dead or risky mirrors (Google webcache, corsproxy.io, allorigins, cors-anywhere, freezedry) were removed; only resilient maintained archives (Wayback Machine, archive.today) remain.
* **Tests & CI:** a Vitest suite (SSRF, URL normalization, archiver logic) plus a GitHub Actions workflow (typecheck, test, audit) keep regressions out.

## 🚀 What's New in v5.3.4?

* **Config fields now work:** Cache Duration, Context Budget Mode, Manual Context Limit, Max Synthesis Tokens, LLM Context Isolation, LLM Call Budget, FlareSolverr URL, and Crossref email all reach the live run.
* **Stall watchdog is live:** a 2-minute no-progress detector aborts workers and flushes partial results to synthesis instead of hanging forever.
* **Session time fixed:** `0` = no explicit cap; the effective crawl deadline is now `min(session, LLM watchdog runtime)` so the two settings stop overriding each other.
* **Waterfall fetcher wired in:** worker fetching now cascades standard fetch → got-scraping → FlareSolverr → Wayback Machine.
* **Query mutation via the SDK:** the hard-coded `localhost:1234` endpoint is gone; the loaded LM Studio model is used, on any port.
* **DDG health aligned:** 1 result is a success (matching the tripwire), so tight queries no longer fake-block DDG into 11-minute cooldowns.
* **Misc fixes:** `ReadSkillFile` tool registered, coverage-table ✓/— marks, duplicate-type cleanup, and a configurable Crossref User-Agent.

The **v5.3.3** release introduced an advanced cognitive and architectural overhaul focused on strict factuality, elimination of noise, and intelligent time budgeting.

**🔍 1. Relevance, Not "Coverage"**

* Replaced superficial keyword-hit dimension counters with strict semantic relevance pre-filters.
* Pages that share vocabulary but lack true subject alignment (e.g., SEO linkfarms, gaming streams, irrelevant LLM blog posts) are automatically rejected before entering synthesis.

**📋 2. Auditable Citations & Entity Hygiene**

* Every non-obvious claim requires a direct URL, title, and date mapping. Phantom references and un-crawled citations are completely banned.
* Structured entity extraction prevents snippet-merging glitches (such as misidentifying historical names and case studies).

**🏷️ 3. Claim Strength Guardrails**

* Enforces explicit epistemic tagging on every claim (*documented, disputed, anecdote, speculation*).
* Intensifiers (e.g., "most convincing," "extensively documented") are restricted unless backed by explicit data. A dedicated alternative-explanation worker actively hunts for contradictions and criticisms.

**⏱️ 4. Quality-Budgeted Time Management**

* The orchestrator reserves the final 20% of the session clock exclusively for verification, sorting, and synthesis.
* On session timeout, the system gracefully curates the top-N highest authority sources rather than dumping raw unverified text.

**🛡️ The Unbreakable Search Engine (Waterfall Fetcher)**

* **Tier A (got-scraping):** Native TLS fingerprinting bypasses 80% of passive Cloudflare blocks.


* **Tier B (FlareSolverr):** Optional advanced UI toggle to route aggressive JS challenges through a local headless browser.


* **Tier C (Wayback Machine):** If a website blocks the plugin with a 403 or Captcha, it automatically falls back to cache archives so research never stalls.


* **Tri-Mode Engine Routing:** Choose between Adaptive (fallback on failure), Benchmark (test all engines), or Priority (historical bests).



**🧠 Adaptive Context Budget & Watchdog**

* **No More Context Crashes:** Dynamically calculates safe token limits. It uses a strict Evidence Ledger (compact 120-token cards) instead of raw text, enforcing a hard 18,000-token synthesis ceiling.


* **LLM Call Budget & Stall Detection:** Hard caps on model calls (Standard = 45 calls) prevent infinite loops. A 2-minute stall watchdog safely cancels hung runs and outputs a partial report.



---

## 📦 Installation & Setup

**1. API Keys Setup (Optional but Recommended)**


The plugin works perfectly using free scraping (DDG/Brave/SearXNG), but you can optionally use premium APIs for fast, reliable gap-filling.
Run the plugin once to auto-generate the keys file at:

* **Windows:** `C:\Users\<you>\.deep-swarm-research\api-keys.json`

* **macOS/Linux:** `~/.deep-swarm-research/api-keys.json`


```json
{
  "serperApiKey": "YOUR_SERPER_KEY",
  "braveApiKey": "YOUR_BRAVE_KEY",
  "crossrefMailto": "you@example.com",
  "rssFeedUrls": ["https://feeds.bbci.co.uk/news/rss.xml"],
  "telegramChannels": ["channelname"]
}
```
The optional `crossrefMailto` is used in the Crossref API User-Agent header (required by Crossref for polite pool access).
The optional `rssFeedUrls` and `telegramChannels` enable RSS/Telegram mining as extra evidence sources during research.

**2. Local Document Sources (RAG)**


Want the swarm to research your proprietary files alongside the web? Use the `RAG Add Library` tool to index a local folder. In the LM Studio plugin settings, change Data Sources to `Local documents and web` (or Local only).

---

## 🛠️ Available Tools

**Research & Web**

* **DeepResearch:** The main tool. Give it a topic, get back a full Markdown report with AI analysis, citations, contradiction detection, and 12-dimension coverage.


* **Search:** Scored web results with domain authority tiers.


* **Read Page / Multi-Read:** Fetch and extract up to 10 URLs concurrently. Handles PDFs automatically.


* **ReadSkillFile:** Load a specialized formatting/domain skill file before synthesizing research.



**Local Library & RAG**

* **RAG Add / List / Remove:** Manage indexed local folders with priority tiers (proprietary, internal, reference, general).


* **RAG Search:** Search libraries using BM25 + fuzzy n-gram hybrid scoring.


* **RAG Check Changes:** Detect modified, deleted, or new files.


* **RAG Save / Load Index:** Persist the index to disk for instant access next session.



---

## 🧠 How It Works (The Fail-Safe Agentic Loop)



* **Decomposition:** Breaks the topic into up to 10 specialized worker roles (academic, regulatory, statistical, etc.).


* **Mandatory Local Layer:** The swarm ALWAYS searches local RAG libraries first. If local evidence is sufficient, it skips the web entirely.


* **Gap-Driven Web Search:** External searches are driven strictly by missing dimensions (gaps). Free engines are used first; paid APIs are held in reserve.


* **Anti-Block Fetching:** Pages are fetched using the new Waterfall Strategy. If blocked, it seamlessly falls back to FlareSolverr or web archives.


* **Evidence Ledger:** Workers extract compact "Evidence Cards" sorted into 4 Verification Tiers.


* **Watchdog:** A strict call budget and stall detector prevent infinite loops.


* **Synthesis:** The LLM writes a narrative report in an isolated context, guaranteeing no overflow.



### Progressive Source Approach

For organizations with large datalakes, the plugin searches in priority order:

```text
┌─────────────────────┐
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

```

---

## 📊 Depth Presets

|  | Shallow | Standard | Deep | Deeper | Exhaustive |
| --- | --- | --- | --- | --- | --- |
| **Rounds**<br> | 1

 | 3

 | 5

 | 10

 | 15

 |
| **Worker roles**<br> | 5

 | 5

 | 8

 | 10

 | 10

 |
| **Pages/worker**<br> | 5

 | 8

 | 12

 | 18

 | 25

 |
| **Search engines**<br> | 1

 | 2

 | 3

 | 4

 | 5

 |
| **Link depth**<br> | 1

 | 1

 | 2

 | 2

 | 3

 |
| **Content/page**<br> | 5K

 | 6K

 | 8K

 | 12K

 | 16K

 |
| **Max Sources**<br> | ~50

 | ~80

 | ~150

 | ~250+

 | ~400+

 |

---

## ⚙️ Configuration (LM Studio UI)



| Setting | Description |
| --- | --- |
| **Data Sources**<br> | Web only, Local documents only, or Local documents and web.

 |
| **Research Depth**<br> | Shallow -> Exhaustive. Controls rounds and budgets.

 |
| **Engine Selection Mode**<br> | Adaptive, Benchmark, or Priority.

 |
| **Context Budget Mode**<br> | Auto (Recommended). Dynamically scales token limits.

 |
| **LLM Call Budget**<br> | Standard (Max 45 calls). Prevents infinite loops.

 |
| **LLM Context Isolation**<br> | Strict isolation. Prevents history bleed.

 |
| **Max Session Time**<br> | Hard cap on wall-clock time (minutes; automatically reserves 20% for final synthesis). Set to **0** for no explicit cap (still bounded by the LLM call watchdog runtime).

 |
| **Academic APIs**<br> | Query OpenAlex, Crossref, and arXiv directly for papers.

 |
| **YouTube Search**<br> | Enable YouTube scraping and transcript extraction.

 |
| **Cache Duration**<br> | Days to reuse previously visited pages (default 30). 0 disables caching. |
| **FlareSolverr URL**<br> | Advanced: Local endpoint for Cloudflare bypass (e.g., `[http://127.0.0.1:8191/v1](http://127.0.0.1:8191/v1)`).

  |

---

## 📜 Changelog

* **v5.3.5** - SSRF guard hardened & unit-tested (internal/private IPs, DNS-rebinding, obfuscated addresses, `.local`/`.home.arpa`), archive-on-failure to the Wayback Machine with a local log, RSS & Telegram feed mining, run-health footer on every report, cache duration in days, archive fallback list pruned to resilient mirrors only, and a Vitest suite + GitHub Actions CI.
* **v5.3.4** - Config wiring fix (Cache Duration, Context Budget, Isolation, LLM Call Budget, FlareSolverr, Crossref email now reach the run), active 2-minute stall watchdog with partial-result flush, session-time/LLM-budget cap alignment (`0 = unlimited`), DDG health threshold aligned to the 1-result tripwire, Waterfall fetcher wired into the live fetch path (got-scraping/FlareSolverr/Wayback), SDK-based query mutation (no hard-coded port), configurable Crossref User-Agent, ReadSkillFile tool registered, coverage-table marks, and duplicate-interface cleanup.
* **v5.3.3** - Entity-first query planning, strict relevance pre-filtering, time-budget synthesis reservation, and claim strength verification.
* **v5.3.2** - Multi-tier waterfall fetcher, FlareSolverr Cloudflare bypass, DOM parser crash fix, and AI query planner overhaul.


* **v5.3.1** - Enterprise-grade fail-safe architecture, Watchdog, Context Budget, and Verification Tiers.


* **v5.2.1** - Multi-API, Tri-Mode Engines (Adaptive/Benchmark/Priority), & YouTube transcripts.


* **v5.2.0** - AI-Driven Query Mutation & Anti-Block Upgrades.


* **v5.1** - Native Engine Time Filtering & Architecture.


* **v5.0** - Failure Memory & State Tracking.


* **v4.0** - Session Timeouts.


* **v3.0 & v1.0** - Initial Swarm & Wall-Clock Limits.



---

## 🗣️ Recommended System Prompts

### For 14B+ Models



```text
You are an expert Deep Research Analyst. Your goal is to synthesize complex information from local proprietary databases and the public web into highly structured, objective, and rigorously cited reports.

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

```

### Compact System Prompt (For 7B - 8B models)



```text
You are an expert Research Analyst. Use the "Deep Research" tool for any complex query, setting `depthOverride` based on complexity.

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

```

---

## 📄 License



MIT License