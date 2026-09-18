import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CrawledSource } from "../types";

const DAY_IN_MS = 24 * 60 * 60 * 1000;

// Persistent cache now lives under the plugin's stable data directory instead
// of a cwd-relative `.cache/` (cwd is not guaranteed to be writable/stable
// inside LM Studio).
const CACHE_DIR = path.join(os.homedir(), ".deep-swarm-research", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "visited-pages-v2.json");

const LEGACY_CACHE_FILE = path.resolve(process.cwd(), ".cache", "visited-pages-v1.json");

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_REJECT_TTL_MS = 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 400;

interface CachedVisitedEntry {
  visitedAt: string;
  source: CrawledSource;
}

interface RejectedEntry {
  rejectedAt: string;
  reason: string;
  ttlMs: number;
}

interface CacheFileShape {
  version: 2;
  entries: Record<string, CachedVisitedEntry>;
  rejected: Record<string, RejectedEntry>;
  /** finalUrl (normalized) -> canonical requested URL (normalized) */
  aliases: Record<string, string>;
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    const removeParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "gclid", "fbclid", "mc_cid", "mc_eid",
    ];
    for (const p of removeParams) {
      u.searchParams.delete(p);
    }
    u.hostname = u.hostname.replace(/^www\./, "");
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    u.searchParams.sort();
    return u.toString();
  } catch {
    return raw;
  }
}

function cloneSource<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return { ...value };
}

function normalizeStoredSource(source: CrawledSource): CrawledSource {
  return {
    ...cloneSource(source),
    url: normalizeUrl(source.url),
    finalUrl: normalizeUrl(source.finalUrl ?? source.url),
  };
}

function emptyData(): CacheFileShape {
  return { version: 2, entries: {}, rejected: {}, aliases: {} };
}

export interface VisitedCacheStats {
  entries: number;
  negativeEntries: number;
  file: string;
  maxAgeDays: number;
  maxEntries: number;
}

export class VisitedPageCache {
  private readonly filePath: string;
  private readonly maxAgeDays: number;
  private readonly maxEntries: number;
  private data: CacheFileShape = emptyData();
  private saveTimeout: NodeJS.Timeout | null = null;

  // The UI "Cache Duration" is expressed in days; use it directly.
  constructor(
    maxAgeDays: number = 30,
    filePath: string = CACHE_FILE,
    maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {
    this.maxAgeDays = Math.max(1, Math.floor(maxAgeDays));
    this.maxEntries = Math.max(50, Math.floor(maxEntries));
    this.filePath = filePath;
    this.load();
    this.prune();

    console.log(
      `[CACHE] Initialized (max_age_days=${this.maxAgeDays}, max_entries=${this.maxEntries}) at ${this.filePath}`,
    );
  }

  private resolveKey(url: string): string {
    const key = normalizeUrl(url);
    return this.data.aliases[key] ?? key;
  }

  hasRecent(url: string): boolean {
    const key = this.resolveKey(url);
    const entry = this.data.entries[key];
    if (!entry) return false;
    const age = Date.now() - new Date(entry.visitedAt).getTime();
    if (!Number.isFinite(age) || age > this.maxAgeDays * DAY_IN_MS) {
      delete this.data.entries[key];
      this.scheduleSave();
      return false;
    }
    return true;
  }

  getRecent(url: string): CrawledSource | null {
    const key = this.resolveKey(url);
    if (!this.hasRecent(key)) return null;
    const entry = this.data.entries[key];
    return entry ? cloneSource(entry.source) : null;
  }

  /** True if this URL recently failed or was rejected and should be skipped. */
  isRejected(url: string): boolean {
    const key = this.resolveKey(url);
    const entry = this.data.rejected[key];
    if (!entry) return false;
    const age = Date.now() - new Date(entry.rejectedAt).getTime();
    if (!Number.isFinite(age) || age > entry.ttlMs) {
      delete this.data.rejected[key];
      this.scheduleSave();
      return false;
    }
    return true;
  }

  markVisited(source: CrawledSource): void {
    if (source.origin !== "web") return;
    const normalized = normalizeStoredSource(source);
    this.data.entries[normalized.url] = {
      visitedAt: new Date().toISOString(),
      source: normalized,
    };

    // Map the post-redirect URL back to the requested URL so cache lookups hit
    // regardless of which form is requested later.
    const finalKey = normalizeUrl(normalized.finalUrl ?? normalized.url);
    if (finalKey && finalKey !== normalized.url) {
      this.data.aliases[finalKey] = normalized.url;
    }

    // A successful fetch clears any negative-cache entry for the same URL.
    delete this.data.rejected[normalized.url];
    delete this.data.rejected[finalKey];

    this.enforceCap();
    this.scheduleSave();
  }

  /** Record a failed/rejected URL so it isn't re-fetched on every run. */
  markRejected(url: string, reason: string = "", ttlMs: number = DEFAULT_REJECT_TTL_MS): void {
    const key = normalizeUrl(url);
    this.data.rejected[key] = {
      rejectedAt: new Date().toISOString(),
      reason,
      ttlMs: Math.max(60_000, ttlMs),
    };
    this.enforceCap();
    this.scheduleSave();
  }

  prune(): void {
    const now = Date.now();
    let changed = false;

    for (const [key, entry] of Object.entries(this.data.entries)) {
      const age = now - new Date(entry.visitedAt).getTime();
      if (!Number.isFinite(age) || age > this.maxAgeDays * DAY_IN_MS) {
        delete this.data.entries[key];
        changed = true;
      }
    }

    for (const [key, entry] of Object.entries(this.data.rejected)) {
      const age = now - new Date(entry.rejectedAt).getTime();
      if (!Number.isFinite(age) || age > entry.ttlMs) {
        delete this.data.rejected[key];
        changed = true;
      }
    }

    // Drop aliases that point at entries we just removed.
    for (const [alias, target] of Object.entries(this.data.aliases)) {
      if (!this.data.entries[target]) {
        delete this.data.aliases[alias];
        changed = true;
      }
    }

    if (changed) this.scheduleSave();
  }

  stats(): VisitedCacheStats {
    return {
      entries: Object.keys(this.data.entries).length,
      negativeEntries: Object.keys(this.data.rejected).length,
      file: this.filePath,
      maxAgeDays: this.maxAgeDays,
      maxEntries: this.maxEntries,
    };
  }

  /** Force any pending write to disk immediately. */
  flush(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.writeNow();
  }

  private enforceCap(): void {
    const keys = Object.keys(this.data.entries);
    if (keys.length > this.maxEntries) {
      keys
        .sort(
          (a, b) =>
            new Date(this.data.entries[a].visitedAt).getTime() -
            new Date(this.data.entries[b].visitedAt).getTime(),
        )
        .slice(0, keys.length - this.maxEntries)
        .forEach((key) => {
          delete this.data.entries[key];
        });
    }

    const rejectedKeys = Object.keys(this.data.rejected);
    if (rejectedKeys.length > this.maxEntries) {
      rejectedKeys
        .sort(
          (a, b) =>
            new Date(this.data.rejected[a].rejectedAt).getTime() -
            new Date(this.data.rejected[b].rejectedAt).getTime(),
        )
        .slice(0, rejectedKeys.length - this.maxEntries)
        .forEach((key) => {
          delete this.data.rejected[key];
        });
    }
  }

  private load(): void {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch {
      /* ignore */
    }

    const loaded = this.tryLoad(this.filePath);
    if (loaded) {
      this.data = loaded;
      return;
    }

    // One-time migration from the legacy cwd-relative cache.
    const legacy = this.tryLoadLegacy();
    if (legacy) {
      this.data = legacy;
      this.scheduleSave();
      console.log(`[CACHE] Migrated legacy cache from ${LEGACY_CACHE_FILE}`);
      return;
    }

    this.data = emptyData();
  }

  private tryLoad(file: string): CacheFileShape | null {
    try {
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<CacheFileShape>;
      if (!parsed || typeof parsed !== "object") return null;
      return {
        version: 2,
        entries: parsed.entries ?? {},
        rejected: parsed.rejected ?? {},
        aliases: parsed.aliases ?? {},
      };
    } catch {
      return null;
    }
  }

  private tryLoadLegacy(): CacheFileShape | null {
    try {
      if (!fs.existsSync(LEGACY_CACHE_FILE)) return null;
      const parsed = JSON.parse(fs.readFileSync(LEGACY_CACHE_FILE, "utf-8")) as {
        entries?: Record<string, CachedVisitedEntry>;
      };
      return {
        version: 2,
        entries: parsed.entries ?? {},
        rejected: {},
        aliases: {},
      };
    } catch {
      return null;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.writeNow();
    }, SAVE_DEBOUNCE_MS);
    if (typeof this.saveTimeout.unref === "function") this.saveTimeout.unref();
  }

  private writeNow(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (err: unknown) {
      console.error(
        `[CACHE] Failed to save visited cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
