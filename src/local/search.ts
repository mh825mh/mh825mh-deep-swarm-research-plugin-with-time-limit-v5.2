import type {
  CrawledSource,
  SearchHit,
  SourceTier,
  WorkerRole,
} from "../types";
import {
  getGlobalStore,
  type LibraryPriority,
  type LocalSearchHit,
} from "./store";

const PRIORITY_TIER_MAP: Record<LibraryPriority, SourceTier> = {
  proprietary: "reference",
  internal: "reference",
  reference: "reference",
  general: "general",
};

const PRIORITY_DOMAIN_SCORES: Record<LibraryPriority, number> = {
  proprietary: 95,
  internal: 90,
  reference: 85,
  general: 75,
};

const LOCAL_FRESHNESS_SCORE = 70;

function makeLocalUrl(hit: LocalSearchHit): string {
  const library = encodeURIComponent(hit.libraryId);
  const relativePath = encodeURIComponent(hit.fileRelPath || hit.fileName);
  const chunk = hit.chunkIndex + 1;

  return `local://${library}/${relativePath}/chunk/${chunk}`;
}

function localHitToSearchHit(hit: LocalSearchHit): SearchHit {
  const snippet = hit.text
    .slice(0, 250)
    .replace(/\s+/g, " ")
    .trim();

  return {
    url: makeLocalUrl(hit),
    title: hit.heading
      ? `${hit.fileName} — ${hit.heading}`
      : `${hit.fileName} (${hit.libraryName})`,
    snippet,
    discoveredBy: "local-rag",
  };
}

function localHitToCrawledSource(
  hit: LocalSearchHit,
  query: string,
  role: WorkerRole,
  label: string,
  contentLimit: number,
): CrawledSource {
  let text = hit.text;

  if (hit.contextBefore) {
    text = `${hit.contextBefore}\n---\n${text}`;
  }

  if (hit.contextAfter) {
    text = `${text}\n---\n${hit.contextAfter}`;
  }

  text = text.slice(0, contentLimit);

  const priority = hit.libraryPriority;
  const tier = PRIORITY_TIER_MAP[priority];
  const domainScore = PRIORITY_DOMAIN_SCORES[priority];

  const baseRelevance = Math.min(1, hit.score * 1.5);
  const priorityBoost =
    priority === "proprietary"
      ? 0.15
      : priority === "internal"
        ? 0.1
        : priority === "reference"
          ? 0.05
          : 0;

  const relevanceScore = Math.min(1, baseRelevance + priorityBoost);
  const localUrl = makeLocalUrl(hit);

  return {
    url: localUrl,
    finalUrl: localUrl,
    title: hit.heading
      ? `${hit.fileName} — ${hit.heading}`
      : `${hit.fileName} (${hit.libraryName})`,
    description: text.slice(0, 250).replace(/\s+/g, " ").trim(),
    published: null,
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    outlinks: [],
    sourceQuery: query,
    workerRole: role,
    workerLabel: label,
    domainScore,
    freshnessScore: LOCAL_FRESHNESS_SCORE,
    tier,
    relevanceScore,
    origin: "local",
  };
}

export function searchLocalLibraries(
  query: string,
  maxResults: number,
  libraryIds?: ReadonlyArray<string>,
): ReadonlyArray<SearchHit> {
  const store = getGlobalStore();

  if (!store.hasLibraries) {
    return [];
  }

  return store
    .search(query, maxResults, libraryIds)
    .map(localHitToSearchHit);
}

export function searchLocalForRole(
  query: string,
  role: WorkerRole,
  maxResults = 8,
  roleLibraryMap?: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<SearchHit> {
  const store = getGlobalStore();

  if (!store.hasLibraries) {
    return [];
  }

  return store
    .searchByRole(query, role, maxResults, roleLibraryMap)
    .map(localHitToSearchHit);
}

export function harvestLocalSources(
  queries: ReadonlyArray<string>,
  role: WorkerRole,
  label: string,
  maxTotal: number,
  contentLimit: number,
  libraryIds?: ReadonlyArray<string>,
  roleLibraryMap?: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<CrawledSource> {
  const store = getGlobalStore();

  if (!store.hasLibraries || maxTotal <= 0) {
    return [];
  }

  const seen = new Set<string>();
  const sources: CrawledSource[] = [];

  const mappedLibraryIds = roleLibraryMap?.get(role);
  const useProgressive =
    !libraryIds?.length && !mappedLibraryIds?.length;

  for (const query of queries) {
    if (sources.length >= maxTotal) {
      break;
    }

    const remaining = maxTotal - sources.length;

    const hits = useProgressive
      ? store.searchProgressive(query, remaining)
      : store.search(
          query,
          remaining,
          mappedLibraryIds ?? libraryIds,
        );

    for (const hit of hits) {
      if (sources.length >= maxTotal) {
        break;
      }

      const dedupeKey = `${hit.filePath}:${hit.chunkIndex}`;

      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);

      sources.push(
        localHitToCrawledSource(
          hit,
          query,
          role,
          label,
          contentLimit,
        ),
      );
    }
  }

  return sources;
}

export function isLocalUrl(url: string): boolean {
  return url.startsWith("local://");
}