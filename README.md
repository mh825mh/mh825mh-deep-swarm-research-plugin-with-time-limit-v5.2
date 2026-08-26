🐝 Deep Research w/ Swarm Agent (v5.3.1)

Autonomous deep research for LM Studio. A swarm of specialized AI workers searches your local documents and the web, dynamically adapting its strategy, resolving contradictions, and synthesizing everything into a structured, confidence-scored report.
🚀 What's New in v5.3.1?

This version introduces an enterprise-grade fail-safe architecture, completely eliminating context-overflow crashes, infinite LLM loops, and search-engine IP bans.
🛡️ The Unbreakable Search Engine & ddgr Strategy

     DDG ddgr Bypass: Switched to POST requests to lite.duckduckgo.com/lite/. This mimics the exact behavior of the popular ddgr terminal utility, bypassing DDG's silent blocks and CAPTCHAs.
     10-Web-Archive Fallback: If a website blocks the plugin with a 403 or Captcha (e.g., Cloudflare), it automatically tries 10 different cache archives (Wayback Machine, Google Cache, Archive.today, etc.) so research never stalls.
     Strict Layer Priority: The swarm strictly executes Local RAG -> DDG -> SearxNG -> Direct Sources -> Paid APIs. Free engines do the heavy lifting; APIs are strictly reserved for gap-filling.

🧠 Adaptive Context Budget & Watchdog

     No More Context Crashes: The plugin dynamically calculates the safe token limit based on your chosen mode (Auto/Conservative/Manual). It uses a strict Evidence Ledger (compact 120-token cards) instead of raw text, enforcing a hard 18,000-token synthesis ceiling.
     LLM Call Budget & Stall Detection: Hard caps on model calls (Standard = 45 calls, Deep = 80 calls) prevent infinite loops. If no progress is made for 2 minutes, the watchdog cancels the run and outputs a partial report safely.

✅ Verification Tiers & File Logging

     4-Tier Verification: Sources are automatically sorted into Tiers A (Canonically verified), B (Independently validated), C (Relevant candidate), and REJECTED. Only Tier A & B reach the final LLM recommendations.
     Deterministic Health Reports: Every run generates a timestamped .txt log file in ~/.deep-swarm-research/logs/ containing the full source-health report, search attribution, and watchdog metrics.

📦 Installation & Setup
1. API Keys Setup (Optional but Recommended)

While the plugin works perfectly fine using free scraping (DDG/Brave/SearXNG), you can optionally use premium APIs for fast, reliable gap-filling.

Run the plugin once — it creates a keys file automatically at:

     Windows: C:\Users\<you>\.deep-swarm-research\api-keys.json
     macOS/Linux: ~/.deep-swarm-research/api-keys.json

Open that file and paste your keys:
json
 
  
 
 
{
  "serperApiKey": "YOUR_SERPER_KEY",
  "braveApiKey": "YOUR_BRAVE_KEY"
}
 
 
2. Local Document Sources (RAG)

Want the swarm to research your proprietary files alongside the web?

    Use the RAG Add Library tool to index a local folder.
    In the LM Studio plugin settings, change Data Sources to Local documents and web (or Local documents only).

⚙️ Configuration (LM Studio UI)
Setting
	
Description
Data Sources	Web only (Default), Local documents only, or Local documents and web.
Research Depth	Shallow -> Exhaustive. Controls rounds, per-worker budgets, and link-following aggressiveness.
Context Budget Mode	Auto (Recommended). Dynamically scales token limits to prevent context overflow.
Max Synthesis Input Tokens	Hard cap on tokens sent to the model for final report generation (Default: 18,000).
LLM Call Budget	Standard (Max 45 calls). Hard limit on model calls to prevent infinite loops.
LLM Context Isolation	Strict isolation. Prevents context history bleed between workers and synthesis.
Max Session Time	Hard cap on wall-clock time (minutes). Set to 0 for Unlimited.
Content Per Page	Chars extracted per page (auto-scales, up to 20K).
Academic APIs	Query OpenAlex, Crossref, and arXiv directly for papers.
Encyclopedia Search	Prioritize Grokipedia, Britannica, and Encyclopedia.com.
  
🛠️ Available Tools
Research & Web

     DeepResearch: The main tool. Give it a topic, get back a full Markdown report with AI-written analysis, citations, contradiction detection, 4-tier verification, and a coverage breakdown across 12 research dimensions.
     Search: Scored web results with domain authority tiers. Uses the anti-block multi-engine dispatcher.
     Read Page / Multi-Read: Fetch and extract a single URL (or up to 10 concurrently). Handles PDFs automatically.
     PDF Batch Read: Fetch up to 10 PDF URLs in parallel, returning structured page-by-page content.

Local Library & RAG

     RAG Add Library: Index a local folder into a searchable RAG library with priority tiers (proprietary, internal, reference, general).
     RAG Search: Search across indexed libraries using BM25 + fuzzy n-gram hybrid scoring.
     RAG List/Remove/Update Library: Manage your indexed collections.
     RAG Check Changes: Detect modified, deleted, or newly added files in a library.
     RAG Save/Load Index: Persist the RAG index to disk for instant access in future sessions.

🧠 How It Works (The Fail-Safe Agentic Loop)

    Mandatory Local Layer: The swarm ALWAYS searches local RAG libraries first. If local evidence is sufficient, it skips the web entirely. If not, it generates specific "gaps".
    Gap-Driven Web Search: External searches are driven strictly by missing dimensions (gaps). Free engines (DDG, SearxNG) are used first; paid APIs are held in reserve for stubborn gaps.
    Anti-Block Fetching: Pages are fetched politely using POST requests and rotating headers. If blocked, the plugin seamlessly falls back to 10 web archives.
    Evidence Ledger: Instead of raw text, workers extract compact 120-token "Evidence Cards" sorted into 4 Verification Tiers. Only Tier A & B reach the final LLM.
    Watchdog & Budget: A strict LLM call budget (e.g., 45 calls) and 2-minute stall detector prevent infinite loops. If limits are hit, a deterministic structured report is generated safely.
    Synthesis: The LLM writes a narrative report in a fresh, isolated context, guaranteeing no context overflow.

🗣️ Recommended System Prompt (For 14B+ models)

You are an expert Deep Research Analyst. Your goal is to synthesize complex information from local proprietary databases and the public web into highly structured, objective, and rigorously cited reports.
TOOL INVOCATION RULES

When a user asks for research, analysis, comparisons, or deep dives, you MUST use the "DeepResearch" tool. 

    Map the user's intent to the tool's parameters:
        Use focusAreas to break down complex prompts into specific angles.
        Use depthOverride: "shallow" for quick facts, "standard" for general overviews, "deep/deeper" for technical analysis, and "exhaustive" for comprehensive literature reviews.
    If you have specialized skill files available, use the "ReadSkillFile" tool to read them before synthesizing.

POST-RESEARCH SYNTHESIS FRAMEWORK

When the tool returns the research report, you must structure your response exactly as follows:

    Executive Summary: A concise, 3-4 sentence TL;DR of the core findings.
    Core Analysis: The detailed synthesis. Organize by themes or topics, NOT by source. Weave the information together logically.
    Source Origin & Temporal Context: 
        Explicitly state if the findings are driven by Local/Proprietary data vs. Public Web data.
        Note the time context (e.g., "The internal documents reflect Q3 2023 policies, while web sources reflect 2024 updates").
    Contradictions & Nuance: Highlight any areas where sources disagree. Present both sides objectively. Do not hide conflicting data.
    Coverage Gaps & Next Steps: Identify what information is missing. Suggest specific follow-up queries or areas the user should investigate manually.

STRICT CITATION & CONFIDENCE RULES

    You MUST cite every factual claim using the exact index format provided by the tool: [1], [2], etc.
    NEVER invent, guess, or hallucinate citation numbers. If a fact is not in the provided sources, state that it is outside the scope of the current research.
    If the tool provides [High/Medium/Low Confidence] tags, you MUST preserve and include them in your analysis.
    Prioritize proprietary/internal sources over web sources when they conflict, unless the web source is significantly more recent and verifiable.

TONE & STYLE

    Maintain a highly professional, objective, and analytical tone.
    Avoid filler phrases like "Based on the research provided..." Just deliver the analysis directly.
    Use Markdown formatting (bolding, lists, tables) to make dense information highly readable.

📄 License

MIT License
    
     
