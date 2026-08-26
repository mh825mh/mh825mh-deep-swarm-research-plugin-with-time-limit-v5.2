import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CrawledSource } from "../types";

const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "visited-pages-v1.json");
const DAY_IN_MS = 24 * 60 * 60 * 1000;

interface CachedVisitedEntry {
  visitedAt: string;
  source: CrawledSource;
}

interface CacheFileShape {
  version: 1;
  entries: Record<string, CachedVisitedEntry>;
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
    // FIX: Escaped the dot in regex
    u.hostname = u.hostname.replace(/^www\./, "");
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    u.searchParams.sort();
    return u.toString();
  } catch {
    return raw;
  }
}

function cloneSource<T>(value: T): T {
  // FIX: Use spread/structuredClone for better performance over JSON.parse
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

export class VisitedPageCache {
  private readonly filePath: string;
  private readonly maxAgeDays: number;
  private data: CacheFileShape = {
    version: 1,
    entries: {},
  };
  private saveTimeout: NodeJS.Timeout | null = null;

  // Change the parameter to expect months, defaulting to 24
  constructor(maxAgeMonths: number = 24, filePath: string = CACHE_FILE) {
    // Convert months to days (approx 30 days per month)
    this.maxAgeDays = Math.max(1, Math.floor(maxAgeMonths * 30));
    this.filePath = filePath;
    this.load();
    this.prune();
    
    console.log(`[CACHE] Initialized with max_age_days=${this.maxAgeDays} (${maxAgeMonths} months)`);
  }

  hasRecent(url: string): boolean {
    const key = normalizeUrl(url);
    const entry = this.data.entries[key];
    if (!entry) return false;
    const age = Date.now() - new Date(entry.visitedAt).getTime();
    if (!Number.isFinite(age) || age > this.maxAgeDays * DAY_IN_MS) {
      delete this.data.entries[key];
      this.save();
      return false;
    }
    return true;
  }

  getRecent(url: string): CrawledSource | null {
    const key = normalizeUrl(url);
    if (!this.hasRecent(key)) return null;
    const entry = this.data.entries[key];
    return entry ? cloneSource(entry.source) : null;
  }

  markVisited(source: CrawledSource): void {
    if (source.origin !== "web") return;
    const normalized = normalizeStoredSource(source);
    this.data.entries[normalized.url] = {
      visitedAt: new Date().toISOString(),
      source: normalized,
    };
    this.save();
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
    if (changed) {
      this.save();
    }
  }

  stats(): { entries: number; file: string; maxAgeDays: number } {
    return {
      entries: Object.keys(this.data.entries).length,
      file: this.filePath,
      maxAgeDays: this.maxAgeDays,
    };
  }

  private load(): void {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      if (!fs.existsSync(this.filePath)) {
        this.data = { version: 1, entries: {} };
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<CacheFileShape>;
      this.data = {
        version: 1,
        entries: parsed.entries ?? {},
      };
    } catch {
      this.data = { version: 1, entries: {} };
    }
  }

  private save(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
      console.log(`[CACHE] Saved ${Object.keys(this.data.entries).length} entries to disk.`);
    } catch (err: any) {
      console.error(`[CACHE] Failed to save visited cache: ${err.message}`);
    }
  }
}