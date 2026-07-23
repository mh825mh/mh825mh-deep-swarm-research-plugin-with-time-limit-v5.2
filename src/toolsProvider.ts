/**
 * @file toolsProvider.ts
 * Registers all four tools with LM Studio.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";

import { configSchematics } from "./config";
import { runDeepResearch } from "./researcher";
import { ResearchConfig } from "./types";
import { DepthPreset, getDepthProfile } from "./constants";
import { searchDDG } from "./net/ddg";
import { fetchPage } from "./net/http";
import { extractPage } from "./net/extractor";
import {
  isPdfUrl,
  isPdfContentType,
  extractPdf,
  PdfImage,
} from "./net/pdf-extractor";
import { scoreCandidate, rankCandidates } from "./scoring/authority";
import { sleep } from "./net/http";
import {
  MULTI_READ_BATCH_DELAY_MS,
  CONTENT_LIMIT_MIN,
  CONTENT_LIMIT_MAX,
  CONTENT_LIMIT_EXTENDED,
  SEARCH_RESULTS_MIN,
  SEARCH_RESULTS_MAX,
} from "./constants";

import {
  getGlobalStore,
  LibraryPriority,
  LibraryTag,
} from "./local/store";

function readConfig(ctl: ToolsProviderController) {
  const c = ctl.getPluginConfig(configSchematics);
  const depth = c.get("researchDepth") as string;
  const depthPreset: DepthPreset =
    depth === "shallow"
      ? "shallow"
      : depth === "deep"
        ? "deep"
        : depth === "deeper"
          ? "deeper"
          : depth === "exhaustive"
            ? "exhaustive"
            : "standard";
  return {
    depthPreset,
    contentLimitPerPage:
      (c.get("contentLimitPerPage") as number) ||
      getDepthProfile(depthPreset).defaultContentLimit,
    enableLinkFollowing: (c.get("enableLinkFollowing") as string) !== "off",
    enableAIPlanning: (c.get("enableAIPlanning") as string) !== "off",
    safeSearch:
      (c.get("safeSearch") as "strict" | "moderate" | "off") || "moderate",
    enableLocalSources: (c.get("enableLocalSources") as string) !== "off",
  } as const;
}

export async function toolsProvider(
  ctl: ToolsProviderController,
): Promise<Tool[]> {
  const deepResearchTool = tool({
    name: "Research",
    description: `Performs autonomous, multi-round deep web research using a Agent Swarm with AI-powered synthesis.
    parameters: {
  topic: z.string().min(3).describe(/* ... */),
  focusAreas: z.array(z.string()).max(6).optional().describe(/* ... */),
  depthOverride: z
    .enum(["shallow", "standard", "deep", "deeper", "exhaustive"])
    .optional()
    .describe(/* ... */),
  contentLimitOverride: z
    .number()
    .int()
    .min(CONTENT_LIMIT_MIN)
    .max(CONTENT_LIMIT_MAX)
    .optional()
    .describe(/* ... */),

  // NEW:
  sessionTimeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "Override max wall-clock time for this Deep Research call only. " +
      "Session will be aborted once this limit is reached."
    ),
},

HOW IT WORKS:
  1. AI TASK DECOMPOSITION: The loaded model analyses the topic and dynamically creates specialised worker agents with roles. Each worker gets custom queries tailored to its assignment.

  2. PARALLEL SWARM EXECUTION: All workers launch simultaneously:
     • Workers search DuckDuckGo, score candidates by domain authority, fetch pages concurrently
     • Post-fetch RELEVANCE FILTERING discards off-topic pages
     • Multi-window content fingerprinting prevents duplicates
     • Depth and Academic workers follow in-page citations

  3. INTER-AGENT COMMUNICATION: After Round 1, an AI coordinator summarises key findings and suggests follow-up angles for gap-fill workers.

  4. ADAPTIVE GAP-FILL: Coverage gaps are filled by TARGETED workers (e.g., Academic worker for missing evidence, Critical worker for missing controversy).

  5. ADAPTIVE SOURCE COLLECTION: No hard source cap - each worker has its own page budget that scales with depth preset. Collection stops only when: all research dimensions are covered, a round yields zero new sources (stagnation), or all rounds are exhausted.

  6. AI NARRATIVE SYNTHESIS: The loaded model writes a coherent, multi-paragraph research analysis with inline citations.

  7. CONTRADICTION DETECTION: The model identifies claims where sources disagree, with severity ratings.

  8. LOCAL DOCUMENT INTEGRATION: When enabled, each worker searches your indexed RAG libraries BEFORE hitting the web using a PROGRESSIVE SOURCE APPROACH:
     • PROPRIETARY libraries are searched first (highest trust, your confidential data)
     • INTERNAL libraries second (shared team knowledge)
     • REFERENCE libraries third (curated reference materials)
     • GENERAL libraries last (miscellaneous)
     Workers auto-route to the right library by tag: the academic worker searches 'academic'-tagged libraries, the regulatory worker searches 'legal'/'policy' ones, etc.
     Local sources are blended into the final report with [local] origin tags.

WHAT YOU GET:
  A structured Markdown report including:
  - AI-written narrative analysis (primary section)
  - Cross-source contradictions with severity ratings
  - Coverage table (upto 12 research dimensions)
  - Swarm activity summary (sources per worker)
  - Cross-source consensus detection
  - Key findings grouped by dimension (detail layer)
  - Full source details with domain authority, relevance score, and publication date
  - Numbered citation index

USE THIS TOOL for thorough, cited research. Not for simple lookups.
When Local Document Sources is enabled in settings, your indexed RAG libraries are searched progressively (proprietary -> internal -> reference -> general) alongside the web - each worker draws from your most trusted data first, then fills gaps from public sources. Use 'RAG Add Library' to create libraries with priority tiers and auto-routing tags.`,
    parameters: {
      topic: z
        .string()
        .min(3)
        .describe(
          "The research topic or question. Be specific. " +
          "Example: 'long-term safety profile of GLP-1 receptor agonists' rather than just 'weight loss drugs'.",
        ),
      focusAreas: z
        .array(z.string())
        .max(6)
        .optional()
        .describe(
          "Optional sub-topics or angles to emphasise across all worker queries. " +
          "Example: ['side effects', 'clinical trial data', 'FDA approval status']",
        ),
      depthOverride: z
        .enum(["shallow", "standard", "deep", "deeper", "exhaustive"])
        .optional()
        .describe(
          "Override depth for this call only. " +
          "shallow = 1 round (~10-25 sources, fast) · " +
          "standard = 3 rounds (~30-60 sources) · " +
          "deep = 5 rounds (~60-120 sources, thorough) · " +
          "deeper = 10 rounds (~100-200+ sources, very thorough) · " +
          "exhaustive = 15 rounds (200+ sources, maximum depth)",
        ),
      contentLimitOverride: z
        .number()
        .int()
        .min(CONTENT_LIMIT_MIN)
        .max(CONTENT_LIMIT_MAX)
        .optional()
        .describe(
          "Override chars-per-page for this call only. " +
          "Higher = richer context per source but slower overall.",
        ),
    },

    // src/toolsProvider.ts

implementation: async (
  args: {
    topic: string;
    focusAreas?: string[];
    depthOverride?: "shallow" | "standard" | "deep" | "deeper" | "exhaustive";
    contentLimitOverride?: number;
    sessionTimeoutMinutes?: number;
  },
  { status, warn, signal },
) => {
  const {
    topic,
    focusAreas,
    depthOverride,
    contentLimitOverride,
    sessionTimeoutMinutes,
  } = args;

  const cfg = readConfig(ctl);
  const timeoutMinutes = sessionTimeoutMinutes ?? 15;
  const maxMs = timeoutMinutes * 60_000;
  const currentDateIso = new Date().toISOString();

  const researchCfg: ResearchConfig = {
    topic,
    focusAreas: focusAreas ?? [],
    depthPreset: (depthOverride as DepthPreset) ?? cfg.depthPreset,
    contentLimitPerPage: contentLimitOverride ?? cfg.contentLimitPerPage,
    enableLinkFollowing: cfg.enableLinkFollowing,
    enableAIPlanning: cfg.enableAIPlanning,
    safeSearch: cfg.safeSearch,
    enableLocalSources: cfg.enableLocalSources,
    maxSessionMs: maxMs,
  };

  const sessionController = new AbortController();
  const sessionSignal = sessionController.signal;

  if (signal.aborted) {
    sessionController.abort();
  } else {
    signal.addEventListener(
      "abort",
      () => {
        sessionController.abort();
      },
      { once: true },
    );
  }

  const timeoutId = setTimeout(() => {
    if (!sessionSignal.aborted) {
      status(
        `\n Max session time (${timeoutMinutes} min) reached — aborting deep research.`,
      );
      sessionController.abort();
    }
  }, maxMs);

  try {
    const result = await runDeepResearch(
      researchCfg,
      status,
      warn,
      sessionSignal,
    );

    clearTimeout(timeoutId);

    return {
      topic,
      totalRounds: result.totalRounds,
      totalSources: result.totalSources,
      queriesUsed: result.queriesUsed,
      coveredDimensions: result.report.coveredDims,
      gapDimensions: result.report.gapDims,
      hasAISynthesis: !!result.report.aiSynthesis,
      contradictions: result.report.contradictions.length,
      report: result.report.markdown,
      sourceIndex: result.report.sources.map((s) => ({
        index: s.index,
        title: s.title,
        url: s.url,
        published: s.published,
        domainScore: s.domainScore,
        tier: s.tier,
        workerRole: s.workerRole,
        workerLabel: s.workerLabel,
        relevance: Math.round(s.relevanceScore * 100),
        origin: s.origin,
        excerpt: s.description.slice(0, 200),
      })),
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);

    if (isAbortError(err)) {
      if (signal.aborted) {
        return "Research cancelled by user.";
      }
      return `Research stopped after ${timeoutMinutes} minutes (session time limit reached).`;
    }

    const msg = errorMessage(err);
    warn(`Deep research error: ${msg}`);
    return `Error during deep research: ${msg}`;
  }
},
  });

  const researchSearchTool = tool({
    name: "Search",
    description:
      "Search DuckDuckGo and return scored, ranked results with domain authority tiers. " +
      "Each result includes a domain score (0-100), source tier (academic/government/news/etc.), " +
      "URL quality score, and freshness estimate. Results are ranked by combined quality. " +
      "Use this for focused lookups. For full research, use 'Research'." +
      "Don't use this for searching local files.",
    parameters: {
      query: z
        .string()
        .min(2)
        .describe(
          "Search query - use natural language as you would type into a search engine.",
        ),
      maxResults: z
        .number()
        .int()
        .min(SEARCH_RESULTS_MIN)
        .max(SEARCH_RESULTS_MAX)
        .optional()
        .describe("Max results to return (default: 8)."),
    },

    implementation: async ({ query, maxResults }, { status, warn, signal }) => {
      const cfg = readConfig(ctl);
      const max = maxResults ?? 8;

      status(`Searching: "${query}"`);

      try {
        const hits = await searchDDG(query, max, cfg.safeSearch, signal);
        const scored = hits.map((h) => scoreCandidate(h, query));
        const ranked = rankCandidates(scored, max);

        status(`Found ${ranked.length} ranked results.`);

        return ranked.map((c, i) => ({
          rank: i + 1,
          url: c.url,
          title: c.title,
          snippet: c.snippet,
          domainScore: c.domainScore,
          freshnessScore: c.freshnessScore,
          urlQuality: c.urlQuality,
          totalScore: c.totalScore,
          tier: c.tier,
        }));
      } catch (err: unknown) {
        if (isAbortError(err) || signal.aborted) return "Search cancelled.";
        const msg = errorMessage(err);
        warn(`Search error: ${msg}`);
        return `Error during search: ${msg}`;
      }
    },
  });

  const researchReadPageTool = tool({
    name: "Read Page",
    description:
      "Visit a website URL and return cleanly extracted text using Mozilla Readability " +
      "(the same engine as Firefox Reader Mode). " +
      "Automatically detects PDF URLs (arXiv, Springer, IEEE, etc.) and extracts " +
      "text content and embedded images from the PDF instead of returning garbled bytes. " +
      "Also returns: title, description, detected publication date, word count, " +
      "domain authority score, source tier, and top outbound links. " +
      "For PDFs, embedded images are saved to temp files and returned as file paths " +
      "with dimensions and size metadata (not inline base64). " +
      "Use this to read individual pages. For reading multiple URLs at once use 'Multi-Read'." +
      "with dimensions and size metadata (not inline base64). " +
      "Don't use this for reading local files.",
    parameters: {
      url: z.string().url().describe("The URL to visit and read."),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "The page number to read (starting from 1). Use this to read long documents " +
          "in chunks. If the returned 'totalPages' is greater than 'page', you can " +
          "call this tool again with the next page number to continue reading.",
        ),
      contentLimit: z
        .number()
        .int()
        .min(CONTENT_LIMIT_MIN)
        .max(CONTENT_LIMIT_EXTENDED)
        .optional()
        .describe(
          "Maximum characters to extract from the page " +
          "(default: plugin content-per-page setting).",
        ),
    },

    implementation: async ({ url, page: pageNum = 1, contentLimit }, { status, warn, signal }) => {
      const cfg = readConfig(ctl);
      const limit = contentLimit ?? cfg.contentLimitPerPage;

      status(`Reading: ${url} (page ${pageNum})`);

      try {
        const fetchResult = await fetchPage(url, signal);
        const { finalUrl } = fetchResult;

        const isPdf =
          (fetchResult.rawBuffer &&
            isPdfContentType(fetchResult.contentType)) ||
          (!fetchResult.rawBuffer && isPdfUrl(url));

        let page: ReturnType<typeof extractPage> & {
          images?: ReadonlyArray<PdfImage>;
        };
        let images: ReadonlyArray<PdfImage> = [];

        if (isPdf && fetchResult.rawBuffer) {
          status(`Found PDF - extracting contents (page ${pageNum})`);
          const pdfResult = await extractPdf(
            fetchResult.rawBuffer,
            url,
            finalUrl,
            limit,
            true,
            20,
            pageNum,
          );
          page = pdfResult;
          images = pdfResult.images;
        } else if (
          isPdf &&
          fetchResult.html &&
          fetchResult.html.startsWith("%PDF")
        ) {
          status(`Found PDF - extracting contents (page ${pageNum})`);
          const buf = Buffer.from(fetchResult.html, "binary");
          const pdfResult = await extractPdf(
            buf,
            url,
            finalUrl,
            limit,
            true,
            20,
            pageNum,
          );
          page = pdfResult;
          images = pdfResult.images;
        } else {
          page = extractPage(fetchResult.html, url, finalUrl, limit, undefined, pageNum);
        }

        const scored = scoreCandidate(
          { url, title: page.title, snippet: page.description },
          "",
        );

        status(
          images.length > 0
            ? `Page read successfully. Extracted ${images.length} image(s).`
            : "Page read successfully.",
        );

        const result: Record<string, unknown> = {
          url: page.finalUrl,
          title: page.title,
          description: page.description,
          published: page.published,
          wordCount: page.wordCount,
          domainScore: scored.domainScore,
          tier: scored.tier,
          content: page.text,
          page: page.page,
          totalPages: page.totalPages,
          topLinks: page.outlinks.slice(0, 10).map((l) => ({
            text: l.text,
            href: l.href,
          })),
        };

        if (images.length > 0) {
          result.images = images.map((img, idx) => ({
            index: idx + 1,
            page: img.page,
            format: img.format,
            width: img.width,
            height: img.height,
            sizeKB: Math.round(img.byteSize / 1024),
            filePath: img.filePath,
          }));
          result.imageCount = images.length;

          const imageNote = images
            .map(
              (img, idx) =>
                `[Image ${idx + 1} on page ${img.page}: ${img.width}×${img.height}, ${Math.round(img.byteSize / 1024)} KB - saved to ${img.filePath}]`,
            )
            .join("\n");
          result.content =
            (result.content as string) +
            "\n\n--- Extracted Images ---\n" +
            imageNote;
        }

        return result;
      } catch (err: unknown) {
        if (isAbortError(err) || signal.aborted) return "Page read cancelled.";
        const msg = errorMessage(err);
        warn(`Read error: ${msg}`);
        return `Error reading page: ${msg}`;
      }
    },
  });

  const researchMultiReadTool = tool({
    name: "Multi-Read",
    description:
      "Fetch up to 10 URLs concurrently (3 at a time) and return extracted text " +
      "and metadata for all of them. Automatically handles PDF URLs - extracts " +
      "clean text instead of returning garbled binary data. Returns domain authority " +
      "score, publication date, and word count per page. " +
      "Use this when you already have a list of URLs and want to read them all " +
      "at once without running a full research session.",
    parameters: {
      urls: z
        .array(z.string().url())
        .min(1)
        .max(10)
        .describe("List of URLs to read (1-10)."),
      contentLimit: z
        .number()
        .int()
        .min(CONTENT_LIMIT_MIN)
        .max(CONTENT_LIMIT_EXTENDED)
        .optional()
        .describe(
          "Maximum characters to extract per page " +
          "(default: plugin content-per-page setting).",
        ),
    },

    implementation: async (
      { urls, contentLimit },
      { status, warn, signal },
    ) => {
      const cfg = readConfig(ctl);
      const limit = contentLimit ?? cfg.contentLimitPerPage;

      status(`Reading ${urls.length} page(s) - 3 at a time…`);

      const CONCURRENCY = 3;
      const results: Array<{
        index: number;
        url: string;
        title: string;
        published: string | null;
        wordCount: number;
        domainScore: number;
        tier: string;
        content: string;
        error: string | null;
      }> = [];

      for (let i = 0; i < urls.length; i += CONCURRENCY) {
        if (signal.aborted) break;

        const batch = urls.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (url, bi) => {
            const fetchResult = await fetchPage(url, signal);
            const { finalUrl } = fetchResult;

            const isPdf =
              (fetchResult.rawBuffer &&
                isPdfContentType(fetchResult.contentType)) ||
              (!fetchResult.rawBuffer && isPdfUrl(url));

            let page;
            if (isPdf && fetchResult.rawBuffer) {
              page = await extractPdf(
                fetchResult.rawBuffer,
                url,
                finalUrl,
                limit,
                false,
              );
            } else if (
              isPdf &&
              fetchResult.html &&
              fetchResult.html.startsWith("%PDF")
            ) {
              const buf = Buffer.from(fetchResult.html, "binary");
              page = await extractPdf(buf, url, finalUrl, limit, false);
            } else {
              page = extractPage(fetchResult.html, url, finalUrl, limit);
            }

            const scored = scoreCandidate(
              { url, title: page.title, snippet: page.description },
              "",
            );
            return {
              index: i + bi + 1,
              url: page.finalUrl,
              title: page.title,
              published: page.published,
              wordCount: page.wordCount,
              domainScore: scored.domainScore,
              tier: scored.tier,
              content: page.text,
              page: page.page,
              totalPages: page.totalPages,
              error: null as string | null,
            };
          }),
        );

        for (let bi = 0; bi < settled.length; bi++) {
          const outcome = settled[bi];
          if (outcome.status === "fulfilled") {
            results.push(outcome.value);
          } else {
            const msg = errorMessage(outcome.reason);
            if (!isAbortError(outcome.reason)) {
              warn(`Failed to read ${batch[bi]}: ${msg}`);
            }
            results.push({
              index: i + bi + 1,
              url: batch[bi],
              title: "",
              published: null,
              wordCount: 0,
              domainScore: 0,
              tier: "general",
              content: "",
              error: msg,
            });
          }
        }

        if (i + CONCURRENCY < urls.length)
          await sleep(MULTI_READ_BATCH_DELAY_MS);
      }

      const succeeded = results.filter((r) => r.error === null).length;
      status(`Done: ${succeeded}/${urls.length} pages read successfully.`);

      if (succeeded === 0) {
        return "All page reads failed. Verify the URLs are publicly accessible.";
      }

      return results;
    },
  });

  const ragAddLibraryTool = tool({
    name: "RAG Add Library",
    description:
      "Index a local folder into a searchable RAG library with priority and tag metadata. " +
      "Multiple libraries can coexist - like GPT4All's multi-library model. " +
      "Each library has a priority tier (proprietary > internal > reference > general) " +
      "and tags for automatic worker routing (e.g. 'legal', 'academic', 'technical'). " +
      "When 'Research' runs with local sources enabled, workers search the right " +
      "libraries based on their role: the academic worker prefers 'academic'-tagged libraries, " +
      "the regulatory worker prefers 'legal'/'policy'-tagged ones, etc. " +
      "Supports 30+ file types: text, markdown, HTML, code, CSV, JSON, XML, Jupyter notebooks, and more. " +
      "Re-indexing a folder that was already indexed replaces the old library.",
    parameters: {
      name: z
        .string()
        .min(1)
        .max(100)
        .describe(
          "A descriptive name for this library, e.g. 'Company Policies', " +
          "'Research Papers', 'Client Reports'. Used in search results and reports.",
        ),
      folderPath: z
        .string()
        .min(1)
        .describe(
          "Absolute path to the folder containing your documents. " +
          "All supported files in subdirectories will be included.",
        ),
      priority: z
        .enum(["proprietary", "internal", "reference", "general"])
        .optional()
        .describe(
          "Priority tier for progressive source retrieval. " +
          "proprietary = searched first, highest trust (your own confidential data). " +
          "internal = second priority (shared team knowledge). " +
          "reference = third priority (curated reference materials). " +
          "general = lowest priority (miscellaneous). " +
          "Default: general.",
        ),
      tags: z
        .array(
          z.enum([
            "legal",
            "academic",
            "technical",
            "financial",
            "medical",
            "policy",
            "reports",
            "code",
            "general",
          ]),
        )
        .optional()
        .describe(
          "Tags for automatic worker routing. Workers search matching libraries first. " +
          "Examples: ['legal'] for contracts/policies, ['academic', 'technical'] for papers, " +
          "['financial', 'reports'] for financial data. Default: ['general'].",
        ),
      description: z
        .string()
        .max(500)
        .optional()
        .describe("Optional description of what this library contains."),
    },

    implementation: async (
      { name, folderPath, priority, tags, description },
      { status },
    ) => {
      try {
        const store = getGlobalStore();
        const cfg = readConfig(ctl);
        const library = await store.indexLibrary(
          name,
          folderPath,
          description ?? "",
          (priority as LibraryPriority) ?? "general",
          (tags as LibraryTag[]) ?? ["general"],
          cfg.contentLimitPerPage,
          status,
        );
        return {
          success: true,
          library: {
            id: library.id,
            name: library.name,
            folderPath: library.folderPath,
            description: library.description,
            priority: library.priority,
            tags: library.tags,
            fileCount: library.fileCount,
            chunkCount: library.chunkCount,
            totalWords: library.totalWords,
            indexedAt: library.indexedAt,
            fileTypes: summariseFileTypes(library.files),
          },
          instructions:
            "Library indexed. Enable 'Local Document Sources' in plugin settings " +
            "to include these documents in 'Research' results. " +
            `Priority: ${library.priority} - ` +
            (library.priority === "proprietary"
              ? "will be searched first, before all other sources."
              : library.priority === "internal"
                ? "will be searched after proprietary libraries."
                : "will be searched alongside other libraries."),
        };
      } catch (err: unknown) {
        return `Error indexing library: ${errorMessage(err)}`;
      }
    },
  });

  const ragListLibrariesTool = tool({
    name: "RAG List Libraries",
    description:
      "List all indexed RAG libraries with their metadata, stats, and priority tiers. " +
      "Shows library name, priority, tags, folder path, file counts, chunk counts, " +
      "word totals, and file type breakdown. Libraries are sorted by priority.",
    parameters: {},

    implementation: async () => {
      const store = getGlobalStore();
      const libraries = store.getLibraries();

      if (libraries.length === 0) {
        return {
          libraries: [],
          message:
            "No libraries indexed yet. Use 'RAG Add Library' to index a folder.",
        };
      }

      return {
        libraries: libraries.map((lib) => ({
          id: lib.id,
          name: lib.name,
          folderPath: lib.folderPath,
          description: lib.description,
          priority: lib.priority,
          tags: lib.tags,
          fileCount: lib.fileCount,
          chunkCount: lib.chunkCount,
          totalWords: lib.totalWords,
          indexedAt: lib.indexedAt,
          fileTypes: summariseFileTypes(lib.files),
        })),
        stats: store.getStats(),
      };
    },
  });

  const ragRemoveLibraryTool = tool({
    name: "RAG Remove Library",
    description:
      "Remove an indexed RAG library by its ID. " +
      "Use 'RAG List Libraries' first to find the library ID.",
    parameters: {
      libraryId: z
        .string()
        .uuid()
        .describe("The UUID of the library to remove."),
    },

    implementation: async ({ libraryId }, { status }) => {
      const store = getGlobalStore();
      const library = store.getLibrary(libraryId);

      if (!library) {
        return `Library not found: ${libraryId}`;
      }

      const name = library.name;
      const removed = store.removeLibrary(libraryId);

      if (removed) {
        status(`Removed library "${name}"`);
        return {
          success: true,
          removedLibrary: name,
          remainingLibraries: store.getLibraries().length,
        };
      }

      return "Failed to remove library.";
    },
  });

  const ragSearchTool = tool({
    name: "RAG Search",
    description:
      "Search across your indexed RAG libraries using BM25 + fuzzy n-gram hybrid scoring. " +
      "Returns the most relevant chunks ranked by relevance with context windows " +
      "(text from surrounding chunks for richer understanding). " +
      "Supports progressive mode: searches proprietary libraries first, then internal, " +
      "then reference, then general - stopping early when enough results are found. " +
      "For full research that blends local and web sources, use 'Research' with Local Document Sources enabled.",
    parameters: {
      query: z
        .string()
        .min(1)
        .describe(
          "Search query - natural language works best. Use '*' to list all chunks.",
        ),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe("Maximum results to return (default: 8)."),
      libraryId: z
        .string()
        .uuid()
        .optional()
        .describe("Optional: limit search to a specific library by its ID."),
      progressive: z
        .boolean()
        .optional()
        .describe(
          "Use progressive search (default: true). Searches libraries in priority order: " +
          "proprietary -> internal -> reference -> general. Set to false to search all at once.",
        ),
      includeContext: z
        .boolean()
        .optional()
        .describe(
          "Include surrounding chunk text for richer context (default: true). " +
          "Adds ~200 chars before and after each matched chunk.",
        ),
    },

    implementation: async (
      { query, maxResults, libraryId, progressive, includeContext },
      { status },
    ) => {
      const store = getGlobalStore();

      if (!store.hasLibraries()) {
        return "No libraries indexed. Use 'RAG Add Library' first.";
      }

      const max = maxResults ?? 8;
      const isWildcard = query.trim() === "*";
      const useProgressive = progressive !== false && !libraryId;

      status(
        isWildcard
          ? "Listing all document chunks…"
          : `Searching RAG libraries: "${query}"${useProgressive ? " (progressive)" : ""}`,
      );

      let hits;
      if (isWildcard) {
        const targetIds = libraryId ? [libraryId] : undefined;
        hits = store.listAll(max, targetIds);
      } else if (useProgressive) {
        hits = store.searchProgressive(query, max);
      } else {
        const targetIds = libraryId ? [libraryId] : undefined;
        hits = store.search(query, max, targetIds);
      }

      if (hits.length === 0) {
        return {
          results: [],
          message: "No relevant documents found for this query.",
        };
      }

      status(
        `Found ${hits.length} relevant chunks across ${new Set(hits.map((h) => h.libraryName)).size} library(ies).`,
      );

      const showContext = includeContext !== false;

      return hits.map((h, i) => {
        const result: Record<string, unknown> = {
          rank: i + 1,
          library: h.libraryName,
          priority: h.libraryPriority,
          file: h.fileRelPath || h.fileName,
          fileType: h.fileType,
          heading: h.heading || undefined,
          score: Math.round(h.score * 1000) / 1000,
          bm25Score: Math.round(h.bm25Score * 1000) / 1000,
          wordCount: h.wordCount,
          chunkPosition: `${h.chunkIndex + 1} of ${h.totalChunks}`,
          content: h.text,
        };

        if (showContext) {
          if (h.contextBefore) result.contextBefore = h.contextBefore;
          if (h.contextAfter) result.contextAfter = h.contextAfter;
        }

        return result;
      });
    },
  });

  const ragUpdateLibraryTool = tool({
    name: "RAG Update Library",
    description:
      "Update a library's metadata (name, description, priority, tags) without re-indexing. " +
      "Use this to change a library's priority tier or add/remove tags.",
    parameters: {
      libraryId: z
        .string()
        .uuid()
        .describe("The UUID of the library to update."),
      name: z.string().min(1).max(100).optional().describe("New name."),
      description: z.string().max(500).optional().describe("New description."),
      priority: z
        .enum(["proprietary", "internal", "reference", "general"])
        .optional()
        .describe("New priority tier."),
      tags: z
        .array(
          z.enum([
            "legal",
            "academic",
            "technical",
            "financial",
            "medical",
            "policy",
            "reports",
            "code",
            "general",
          ]),
        )
        .optional()
        .describe("New tags for worker routing."),
    },

    implementation: async (
      { libraryId, name, description, priority, tags },
      { status },
    ) => {
      const store = getGlobalStore();
      const updated = store.updateLibraryMeta(libraryId, {
        name,
        description,
        priority: priority as LibraryPriority | undefined,
        tags: tags as LibraryTag[] | undefined,
      });

      if (!updated) return `Library not found: ${libraryId}`;

      status(`Updated library "${updated.name}"`);
      return {
        success: true,
        library: {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          priority: updated.priority,
          tags: updated.tags,
        },
      };
    },
  });

  const ragCheckChangesTool = tool({
    name: "RAG Check Changes",
    description:
      "Check if files in a library have changed since indexing. " +
      "Shows modified, deleted, and newly added files. " +
      "If changes are found, you can re-index with 'RAG Add Library'.",
    parameters: {
      libraryId: z
        .string()
        .uuid()
        .describe("The UUID of the library to check."),
    },

    implementation: async ({ libraryId }) => {
      const store = getGlobalStore();
      const library = store.getLibrary(libraryId);
      if (!library) return `Library not found: ${libraryId}`;

      const changes = store.checkForChanges(libraryId);
      const hasChanges =
        changes.modified.length > 0 ||
        changes.deleted.length > 0 ||
        changes.added.length > 0;

      return {
        library: library.name,
        hasChanges,
        modified: changes.modified,
        deleted: changes.deleted,
        added: changes.added,
        suggestion: hasChanges
          ? `Re-index with: RAG Add Library(name="${library.name}", folderPath="${library.folderPath}", ` +
          `priority="${library.priority}", tags=${JSON.stringify(library.tags)})`
          : "Library is up to date - no re-indexing needed.",
      };
    },
  });

  const ragSaveIndexTool = tool({
    name: "RAG Save Index",
    description:
      "Save the current RAG index to disk so libraries persist across sessions. " +
      "Saves all libraries, chunks, and metadata to a JSON file. " +
      "Load it later with 'RAG Load Index' to avoid re-indexing.",
    parameters: {
      filePath: z
        .string()
        .min(1)
        .describe(
          "Path to save the index file, e.g. '~/.lmstudio/rag-index.json'. " +
          "Parent directories are created automatically.",
        ),
    },

    implementation: async ({ filePath }, { status }) => {
      try {
        const store = getGlobalStore();
        const resolvedPath = filePath.replace(/^~/, process.env.HOME || "~");
        store.saveIndex(resolvedPath);
        const stats = store.getStats();
        status(`RAG index saved to ${resolvedPath}`);
        return {
          success: true,
          path: resolvedPath,
          stats: {
            libraries: stats.libraries,
            totalChunks: stats.totalChunks,
            totalWords: stats.totalWords,
          },
        };
      } catch (err: unknown) {
        return `Error saving index: ${errorMessage(err)}`;
      }
    },
  });

  const ragLoadIndexTool = tool({
    name: "RAG Load Index",
    description:
      "Load a previously saved RAG index from disk. " +
      "Restores all libraries and chunks without re-scanning files. " +
      "Libraries whose folders no longer exist are skipped.",
    parameters: {
      filePath: z.string().min(1).describe("Path to the saved index file."),
    },

    implementation: async ({ filePath }, { status }) => {
      try {
        const store = getGlobalStore();
        const resolvedPath = filePath.replace(/^~/, process.env.HOME || "~");
        const result = store.loadIndex(resolvedPath);
        const stats = store.getStats();
        status(
          `Loaded ${result.loaded} library(ies)` +
          (result.skipped > 0
            ? `, skipped ${result.skipped} (missing folders)`
            : ""),
        );
        return {
          success: true,
          loaded: result.loaded,
          skipped: result.skipped,
          stats: {
            libraries: stats.libraries,
            totalChunks: stats.totalChunks,
            totalWords: stats.totalWords,
          },
        };
      } catch (err: unknown) {
        return `Error loading index: ${errorMessage(err)}`;
      }
    },
  });

  const pdfBatchReadTool = tool({
    name: "PDF Batch Read",
    description:
      "Fetch and extract text from up to 10 PDF URLs in parallel, returning " +
      "structured page-by-page content for each document. " +
      "Ideal for processing multiple research papers, reports, or manuals at once - " +
      "e.g. 4 PDFs of 20 pages each - where you need to cite specific pages or " +
      "compare content across documents. " +
      "Each result includes the full extracted text, estimated page count, word count, " +
      "and a page-window breakdown so you can reference content by page number. " +
      "Set autoIndex=true to also index all successfully read PDFs into a RAG library " +
      "for later semantic search via 'RAG Search'.",

    parameters: {
      urls: z
        .array(z.string().url())
        .min(1)
        .max(10)
        .describe("PDF URLs to fetch and extract (1-10)."),

      contentLimit: z
        .number()
        .int()
        .min(CONTENT_LIMIT_MIN)
        .max(CONTENT_LIMIT_EXTENDED)
        .optional()
        .describe(
          "Maximum characters to extract per PDF " +
          "(default: plugin content-per-page setting).",
        ),

      pageWindowChars: z
        .number()
        .int()
        .min(500)
        .max(8000)
        .optional()
        .describe(
          "Approximate character width of each page window in the page breakdown. " +
          "Smaller = more granular page citations. Default: 2000.",
        ),

      autoIndex: z
        .boolean()
        .optional()
        .describe(
          "If true, index each successfully extracted PDF into the RAG store " +
          "under a library named after the URL hostname + path. " +
          "Default: false.",
        ),

      indexLibraryName: z
        .string()
        .optional()
        .describe(
          "Library name to use when autoIndex=true. " +
          "Default: 'pdf-batch-<timestamp>'.",
        ),
    },

    implementation: async (
      { urls, contentLimit, pageWindowChars = 2000, autoIndex = false, indexLibraryName },
      { status, warn, signal },
    ) => {
      const cfg = readConfig(ctl);
      const limit = contentLimit ?? cfg.contentLimitPerPage;
      const CONCURRENCY = 3;

      status(`Fetching ${urls.length} PDF(s) - ${CONCURRENCY} at a time…`);

      interface PdfPageWindow {
        pageEstimate: number;
        charStart: number;
        charEnd: number;
        text: string;
      }

      interface PdfReadResult {
        index: number;
        url: string;
        title: string;
        author: string | null;
        published: string | null;
        pageCount: number;
        wordCount: number;
        charCount: number;
        fullText: string;
        pageWindows: PdfPageWindow[];
        indexedAsLibraryId: string | null;
        error: string | null;
      }

      const results: PdfReadResult[] = [];

      for (let i = 0; i < urls.length; i += CONCURRENCY) {
        if (signal.aborted) break;

        const batch = urls.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (url, bi): Promise<PdfReadResult> => {
            const idx = i + bi + 1;
            status(`[${idx}/${urls.length}] Fetching ${url}…`);

            const fetchResult = await fetchPage(url, signal);
            const { finalUrl } = fetchResult;

            const isPdf =
              (fetchResult.rawBuffer && isPdfContentType(fetchResult.contentType)) ||
              (!fetchResult.rawBuffer && isPdfUrl(url));

            if (!isPdf) {
              return {
                index: idx,
                url: finalUrl,
                title: "",
                author: null,
                published: null,
                pageCount: 0,
                wordCount: 0,
                charCount: 0,
                fullText: "",
                pageWindows: [],
                indexedAsLibraryId: null,
                error: "URL did not return a PDF (wrong Content-Type or URL pattern).",
              };
            }

            const buffer =
              fetchResult.rawBuffer ??
              (fetchResult.html?.startsWith("%PDF")
                ? Buffer.from(fetchResult.html, "binary")
                : null);

            if (!buffer) {
              return {
                index: idx,
                url: finalUrl,
                title: "",
                author: null,
                published: null,
                pageCount: 0,
                wordCount: 0,
                charCount: 0,
                fullText: "",
                pageWindows: [],
                indexedAsLibraryId: null,
                error: "Could not obtain PDF bytes from the response.",
              };
            }

            status(`[${idx}/${urls.length}] Extracting text from PDF…`);
            const extracted = await extractPdf(buffer, url, finalUrl, limit, false);

            const text = extracted.text;
            const pageWindows: PdfPageWindow[] = [];
            const totalPages = extracted.pageCount > 0 ? extracted.pageCount : null;

            if (text.length > 0) {
              const segCount = Math.max(1, Math.ceil(text.length / pageWindowChars));
              const segSize = Math.ceil(text.length / segCount);

              for (let s = 0; s < segCount; s++) {
                const charStart = s * segSize;
                const charEnd = Math.min(charStart + segSize, text.length);
                const pageEstimate = totalPages
                  ? Math.min(totalPages, Math.round((s / segCount) * totalPages) + 1)
                  : s + 1;
                pageWindows.push({
                  pageEstimate,
                  charStart,
                  charEnd,
                  text: text.slice(charStart, charEnd),
                });
              }
            }

            const author: string | null = extracted.pdfAuthor || null;

            let indexedAsLibraryId: string | null = null;
            if (autoIndex) {
              try {
                const tmpDir = os.tmpdir();
                const safeName = url.replace(/[^a-z0-9]/gi, "_").slice(-60);
                const tmpPath = path.join(tmpDir, `pdf_batch_${safeName}.txt`);
                fs.writeFileSync(tmpPath, text, "utf-8");

                const libName =
                  indexLibraryName ||
                  `pdf-batch-${Date.now()}`;

                const store = getGlobalStore();
                const lib = await store.indexLibrary(
                  path.dirname(tmpPath),
                  libName,
                  `Auto-indexed batch PDF: ${extracted.title || url}`,
                  "reference",
                  ["general"],
                );
                indexedAsLibraryId = lib?.id ?? null;
                try { fs.unlinkSync(tmpPath); } catch { }
              } catch (indexErr) {
                warn(
                  `Auto-index failed for ${url}: ${errorMessage(indexErr)}`,
                );
              }
            }

            return {
              index: idx,
              url: finalUrl,
              title: extracted.title,
              author,
              published: extracted.published,
              pageCount: extracted.pageCount > 0 ? extracted.pageCount : pageWindows.length,
              wordCount: extracted.wordCount,
              charCount: text.length,
              fullText: text,
              pageWindows,
              indexedAsLibraryId,
              error: null,
            };
          }),
        );

        for (let bi = 0; bi < settled.length; bi++) {
          const outcome = settled[bi];
          if (outcome.status === "fulfilled") {
            results.push(outcome.value);
          } else {
            const msg = errorMessage(outcome.reason);
            if (!isAbortError(outcome.reason)) {
              warn(`Failed to read PDF ${batch[bi]}: ${msg}`);
            }
            results.push({
              index: i + bi + 1,
              url: batch[bi],
              title: "",
              author: null,
              published: null,
              pageCount: 0,
              wordCount: 0,
              charCount: 0,
              fullText: "",
              pageWindows: [],
              indexedAsLibraryId: null,
              error: msg,
            });
          }
        }

        if (i + CONCURRENCY < urls.length) await sleep(MULTI_READ_BATCH_DELAY_MS);
      }

      const succeeded = results.filter((r) => r.error === null).length;
      const totalWords = results.reduce((s, r) => s + r.wordCount, 0);
      status(
        `Done: ${succeeded}/${urls.length} PDFs read, ~${totalWords.toLocaleString()} words total.`,
      );

      if (succeeded === 0) {
        return "All PDF reads failed. Verify the URLs are accessible and return valid PDFs.";
      }

      return {
        summary: {
          totalRequested: urls.length,
          totalSucceeded: succeeded,
          totalWords,
          autoIndexed: results.filter((r) => r.indexedAsLibraryId !== null).length,
        },
        documents: results,
      };
    },
  });

  return [
    deepResearchTool,
    researchSearchTool,
    researchReadPageTool,
    researchMultiReadTool,
    pdfBatchReadTool,
    ragAddLibraryTool,
    ragListLibrariesTool,
    ragRemoveLibraryTool,
    ragSearchTool,
    ragUpdateLibraryTool,
    ragCheckChangesTool,
    ragSaveIndexTool,
    ragLoadIndexTool,
  ];
}

function summariseFileTypes(
  files: ReadonlyArray<{ fileType: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of files) {
    const ext = f.fileType || "unknown";
    counts[ext] = (counts[ext] ?? 0) + 1;
  }
  return counts;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown error");
}
