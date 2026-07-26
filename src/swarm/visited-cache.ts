import fs from "node:fs";
import path from "node:path";
import { CrawledSource } from "../types";

const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "visited-pages-v1.json");
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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
    u.hostname = u.hostname.replace(/^www./, "");
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    u.searchParams.sort();
    return u.toString();
  } catch {
    return raw;
  }
}

function cloneSource<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
  private data: CacheFileShape = {
    version: 1,
    entries: {},
  };

  constructor(filePath: string = CACHE_FILE) {
    this.filePath = filePath;
    this.load();
    this.prune();
  }

  hasRecent(url: string): boolean {
    const key = normalizeUrl(url);
    const entry = this.data.entries[key];
    if (!entry) return false;
    const age = Date.now() - new Date(entry.visitedAt).getTime();
    if (!Number.isFinite(age) || age > THIRTY_DAYS_MS) {
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
      if (!Number.isFinite(age) || age > THIRTY_DAYS_MS) {
        delete this.data.entries[key];
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  // 👇 ADDED MISSING METHOD
  stats(): { entries: number; file: string; maxAgeDays: number } {
    return {
      entries: Object.keys(this.data.entries).length,
      file: this.filePath,
      maxAgeDays: 30,
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
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch {
      // silent fail
    }
  }
}