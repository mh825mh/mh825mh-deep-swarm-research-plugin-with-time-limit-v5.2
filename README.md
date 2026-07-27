🐝 Deep Research w/ Swarm Agent (v5.2.1)

Autonomous deep research for LM Studio. A swarm of specialized workers searches your local libraries and the web, then synthesizes everything into a structured report - one tool call, no API keys required (but optional API keys supported for maximum power).
🚀 What's New in v5.2.1?

This version introduces a massive overhaul to the search engine architecture, adding API integrations, dynamic routing, and specialized source extraction.
Tri-Mode Engine Routing

You can now control how the swarm selects search engines via the LM Studio plugin settings:

    Adaptive (Default): Starts with DuckDuckGo and role-specific engines (e.g., Encyclopedias for academic workers). If it gets blocked or finds too few sources, it intelligently falls back to other engines.
    Benchmark: Runs all enabled engines for every query to collect performance metrics. Great for short calibration runs to see which engines work best for your topics.
    Priority: Uses historical benchmark data to only fire the absolute best engines for specific worker roles, saving time and bandwidth.
    Ultimate Fallback: If a worker finishes its assigned engines but still hasn't met its source budget, it triggers an "all-out sweep," firing every remaining engine to ensure no stone is left unturned.

New Search Providers & APIs

    Academic APIs: OpenAlex, Crossref, and arXiv are now natively supported for deep academic research.
    Reference Encyclopedias: Prioritizes Grokipedia, Encyclopedia.com, and Britannica over Wikipedia for higher-quality foundational knowledge.
    News & Recency: GDELT and X.com (Twitter) integration for finding the latest news and social sentiment.
    API Keys Supported: Optional fields for Serper API (Google) and Brave Search API. If keys are provided, the swarm will use the fast official APIs instead of scraping.

YouTube Transcript Extraction

YouTube URLs are no longer dead ends. The plugin now intercepts YouTube links, fetches the video's transcript, and formats it with timestamps ([00:15] ...), allowing the LLM to read and cite video content just like a web page.
Engine Attribution & Metrics

The swarm now tracks exactly which engine discovered each final accepted source. The logs will show acceptance rates, duplicate rates, and off-topic rates per engine.
Performance & Caching Upgrades

    Configurable Persistent Cache: You can now choose how long visited pages are kept (30 days, 90 days, 6, 12, or 24 months) to optimize disk usage.
    Async I/O: Fixed blocking Node.js event loop issues. Cache writes and logs are now debounced and asynchronous, preventing LM Studio UI freezes during exhaustive research runs.
    Memory Leak Fixes: JSDOM instances are now properly closed after HTML parsing.

📜 Changelog

v5.2.1 - 🐝 Multi-API, Tri-Mode Engines & YouTube

    Added Tri-Mode engine selection (Adaptive, Benchmark, Priority).
    Added Academic APIs (OpenAlex, Crossref, arXiv) and GDELT news.
    Added Encyclopedia priority (Grokipedia, Britannica, Encyclopedia.com).
    Added YouTube transcript extraction.
    Added optional Serper and Brave API key support.
    Configurable persistent cache durations.
    Fixed critical memory leaks and async I/O blocking.

v5.2.0 - 🧠 AI & Anti-Block Upgrades

    LLM-Driven Query Mutation: Replaces static string guessing with local LM Studio API for context-aware discovery.
    Wayback Machine Fallback: Auto-retries blocked/403/Cloudflare URLs via Archive.org snapshots.
    Smart Domain Blacklisting: Tracks failing domains in SharedCrawlState; auto-skips after 3 failures to save crawl budget.
    Advanced Boilerplate Stripping: Removes <img>, <svg>, hidden elements, paywalls, and cookie banners before Readability parsing, saving ~30-40% tokens.
    Table & Code Preservation: Forces Readability to keep <table> and <pre><code> blocks intact.
    Anti-SEO Spam Penalty: Halves relevance score for pages with >5% URL density (link farms).

v5.1 - ⏱️ Native Engine Time Filtering & Architecture

    Core Added Feature: Native time-range parameters injected directly into search engine URLs (DDG df, Brave qdr, SearXNG time_range). Guarantees fresh results and saves crawl budget.
    Architecture Improvement: End-to-end state propagation so the time constraint survives from the UI down to the lowest-level network requests.

v5.0 - 🧠 Failure Memory & State Tracking

    Added failure memory to the swarm crawl state so failed URLs and repeatedly failing hosts are tracked and can be skipped on later fetch attempts.
    Updated worker fetch flow to support avoiding blocked or unstable sources instead of retrying the same bad URLs repeatedly.

v4.0 - ⏳ Session Timeouts

    Added session timeout support to the Research tool so long-running deep research jobs can stop automatically after a configurable time limit.

v3.0 & v1.0 - 🐝 Initial Swarm & Wall-Clock Limits

    Deep Research now supports a configurable max session time. Each run can be capped by a user-defined wall-clock limit. Once the timer aborts the signal, future rounds stop, but any workers already running in the current round still finish before Swarm resolves it.

🛠️ Tools
Research

The main tool. Give it a topic, get back a full Markdown report with AI-written analysis, citations, contradiction detection, and a coverage breakdown across 12 research dimensions. When local document sources are enabled, workers search your RAG libraries progressively - proprietary first, web to fill gaps.

Parameters:

    topic - what to research (be specific)
    focusAreas - optional angles to emphasize, e.g. ["side effects", "FDA status"]
    depthOverride - "shallow" / "standard" / "deep" / "deeper" / "exhaustive"
    contentLimitOverride - chars per page (1K-20K, auto-scales with depth)

Search

Scored DuckDuckGo results with domain authority tiers and snippet extraction.
Read Page

Fetch and extract a single URL. Handles PDFs automatically.
Multi-Read

Batch-fetch up to 10 URLs concurrently.
📚 Local Library Tools (RAG)
Add Library

Index a local folder into a searchable library with full metadata.Parameters:

    name - descriptive name (e.g. "Company Policies", "Research Papers")
    folderPath - absolute path to the document folder
    priority - "proprietary" / "internal" / "reference" / "general" (default: general)
    tags - array of routing tags: ["legal"], ["academic", "technical"], ["financial", "reports"], etc.
    description - optional description

List Libraries

Show all indexed libraries sorted by priority, with file counts, chunk counts, word totals, tags, and file type breakdown.
Remove Library

Remove a library by its UUID (id).
Search

Search across libraries with BM25 + fuzzy hybrid scoring mechanism.Features:

    Progressive mode (default): searches proprietary -> internal -> reference -> general
    Context windows: includes surrounding chunk text with each result
    Library-specific search: filter to a single library by ID
    Heading-aware: boosts results where the query matches section headings

Update Library

Change a library's name, description, priority, or tags without re-indexing.
Check Changes

Detect modified, deleted, and newly added files since last indexing.
Save Index

Persist the entire RAG index to a JSON file on disk.
Load Index

Restore a previously saved index - instant library access without re-scanning.

Supported file types: .txt, .md, .html, .csv, .json, .xml, .log, and many more.
🧠 How It Works

    Decomposes the topic into specialized workers (up to 10 roles: breadth, depth, recency, academic, critical, statistical, regulatory, technical, primary sources, comparative)
    Searches local/RAG libraries progressively - proprietary -> internal -> reference -> general, with auto-routing by tag. Each worker claims up to 30% of its page budget from local sources before touching the web
    Searches the web across multiple engines in parallel - DuckDuckGo, Brave, Google Scholar, SearXNG, Mojeek, APIs (Serper, Brave), and Academic APIs (OpenAlex, Crossref, arXiv).
    Fetches & extracts pages with aggressive boilerplate removal, relevance scoring, and duplicate detection. YouTube videos are transcribed.
    Follows links recursively (1-3 levels deep depending on depth preset)
    Detects gaps across 12 research dimensions and spawns targeted follow-up workers
    Stops intelligently - when coverage is complete, sources stagnate, or rounds run out
    Synthesizes a narrative report with inline citations, contradiction detection, and source origin tags (web vs local)

Progressive Source Approach

This is the key innovation for organizations with large proprietary datalakes. Instead of treating all sources equally, the plugin searches in priority order:

┌─────────────────────┐│  1. PROPRIETARY      │  < Your confidential data (contracts, internal memos, trade secrets)│     Searched first   │├─────────────────────┤│  2. INTERNAL         │  < Shared team knowledge (wikis, documentation, reports)│     Searched second  │├─────────────────────┤│  3. REFERENCE        │  < Curated reference materials (papers, standards, regulations)│     Searched third   │├─────────────────────┤│  4. GENERAL          │  < Miscellaneous local documents│     Searched fourth  │├─────────────────────┤│  5. WEB              │  < Public internet (fills remaining gaps)│     Searched last    │└─────────────────────┘

Workers also auto-route to the right library by tag:

     Academic worker -> searches academic and technical tagged libraries
     Regulatory worker -> searches legal and policy tagged libraries  
     Technical worker -> searches technical and code tagged libraries
     Statistical worker -> searches financial and reports tagged libraries

🚀 Quick Start

1. Index your document libraries (Optional):
text
 
  
 
 
RAG Add Library(name: "Research Papers", folderPath: "/papers", priority: "reference", tags: ["academic"])
RAG Add Library(name: "Internal Docs", folderPath: "/company/docs", priority: "internal", tags: ["reports"])
RAG Add Library(name: "Legal", folderPath: "/legal", priority: "proprietary", tags: ["legal", "policy"])
 
 

2. Enable local sources in plugin settings (Local Document Sources -> On)

3. Run Deep Research as usual - workers will search your libraries progressively

4. Save your index so you don't need to re-index next session:
text
 
  
 
 
RAG Save Index(filePath: "~/.lmstudio/rag-index.json")
 
 

5. Next session, load it back:
text
 
  
 
 
RAG Load Index(filePath: "~/.lmstudio/rag-index.json")
 
 
📊 Depth Presets
	
Shallow
	
Standard
	
Deep
	
Deeper
	
Exhaustive
Rounds	1	3	5	10	15
Worker roles	5	5	8	10	10
Pages/worker	5	8	12	18	25
Search engines	1	2	3	4	5
Link depth	1	1	2	2	3
Fan-out	x1	x1	x2	x2	x3
Content/page	5K	6K	8K	12K	16K
Sources (upto)	~25-50	~40-80	~80-150	~150-250+	~250-400+
  

No hard source cap - collection is fully adaptive. Local sources are additional - they don't eat into the web budget shown above.
⚙️ Configuration
Setting
	
Description
Search Time Range	Filter results by date (All time, Past year, month, week, 24 hours).
Research Depth	Shallow -> Exhaustive (scales everything).
Engine Selection Mode	adaptive, benchmark, or priority.
Persistent Cache Duration	How long to keep scraped pages in the .cache folder.
Content Per Page	Chars extracted per page (auto-scales, up to 20K).
Link Following	Follow in-page citations and references.
AI Query Planning	Use loaded model for query generation and synthesis.
Safe Search	DuckDuckGo safe search level.
Local Document Sources	Search indexed local/RAG libraries alongside the web.
Max Session Time	Hard cap on wall-clock time (minutes) to prevent runaway research.
X.com (Twitter) Search	Enable scraping X.com (uses strict delays to avoid bans).
YouTube Transcript Search	Enable YouTube scraping and transcript extraction.
Academic APIs	Enable OpenAlex, Crossref, and arXiv.
Encyclopedia Search	Prioritize Grokipedia, Encyclopedia.com, and Britannica.
Serper API Key	Optional. Provide a key to use the Serper Google Search API.
Brave Search API Key	Optional. Provide a key to use the Brave Search API.
  
🗣️ Recommended System Prompt (For 14B+ models)
text
 
  
 
 
You are an expert Deep Research Analyst. Your goal is to synthesize complex information from local proprietary databases and the public web into highly structured, objective, and rigorously cited reports.

### TOOL INVOCATION RULES
When a user asks for research, analysis, comparisons, or deep dives, you MUST use the "Deep Research" tool. 
- Map the user's intent to the tool's parameters:
  - Use `focusAreas` to break down complex prompts into specific angles.
  - Use `depthOverride`: "shallow" for quick facts, "standard" for general overviews, "deep/deeper" for technical analysis, and "exhaustive" for comprehensive literature reviews.
- If the user asks for "recent", "latest", or "current" events, remind them to ensure the plugin's "Search Time Range" is set to Past Week/Month.

### POST-RESEARCH SYNTHESIS FRAMEWORK
When the tool returns the research report, you must structure your response exactly as follows:

1. **Executive Summary**: A concise, 3-4 sentence TL;DR of the core findings.
2. **Core Analysis**: The detailed synthesis. Organize by *themes or topics*, NOT by source. Weave the information together logically.
3. **Source Origin & Temporal Context**: 
   - Explicitly state if the findings are driven by Local/Proprietary data vs. Public Web data. 
   - Note the time context (e.g., "The internal documents reflect Q3 2023 policies, while web sources reflect 2024 updates").
4. **Contradictions & Nuance**: Highlight any areas where sources disagree. Present both sides objectively. Do not hide conflicting data.
5. **Coverage Gaps & Next Steps**: Identify what information is missing. Suggest specific follow-up queries or areas the user should investigate manually.

### STRICT CITATION & ANTI-HALLUCINATION RULES
- You MUST cite every factual claim using the exact index format provided by the tool: `[1]`, `[2]`, etc.
- NEVER invent, guess, or hallucinate citation numbers. If a fact is not in the provided sources, state that it is outside the scope of the current research.
- If multiple sources support a claim, cite them all: `[1, 4, 7]`.
- Prioritize proprietary/internal sources over web sources when they conflict, unless the web source is significantly more recent and verifiable.

### TONE & STYLE
- Maintain a highly professional, objective, and analytical tone.
- Avoid filler phrases like "Based on the research provided..." Just deliver the analysis directly.
- Use Markdown formatting (bolding, lists, tables) to make dense information highly readable.
 
 
🗣️ Compact System Prompt (For 7B - 8B models)
text
 
  
 
 
You are an expert Research Analyst. Use the "Deep Research" tool for any complex query, setting `depthOverride` based on complexity.

When the tool returns results, format your response exactly like this:
1. **Executive Summary**: 3-sentence TL;DR.
2. **Detailed Analysis**: Synthesize by theme, not by source. 
3. **Source Context**: Note if findings rely on Local/Proprietary docs vs Web, and note the time period of the data.
4. **Contradictions**: Highlight conflicting sources objectively.
5. **Gaps**: What is missing? Suggest follow-ups.

STRICT RULES:
- Cite EVERY claim using the tool's exact numbers: [1], [2], etc. NEVER hallucinate citation numbers.
- Prioritize Local/Proprietary sources over Web sources.
- Do not use filler phrases. Be direct, objective, and use Markdown tables/lists for readability.
 
 
📄 License

MIT License
