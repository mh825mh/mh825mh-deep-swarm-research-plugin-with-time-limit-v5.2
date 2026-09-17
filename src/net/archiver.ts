// src/net/archiver.ts
// Archive-on-failure: when a page fails through every live fetch tier (direct
// fetch, FlareSolverr, Wayback/archive.today snapshots), submit it once to the
// Wayback Machine for preservation and record a local log entry. Politeness
// knob: global de-dup per run, a minimum spacing between submissions, a cap on
// submissions per research run cross the run. Never throws - it is fully
// best-effort and fires in the background.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ArchiveResult =
  | "submitted"
  | "skipped"
  | "failed"
  | "rate-limited";

export interface ArchiveEntry {
  archivedAt: string;
  url: string;
  reason: string;
  lastError?: string;
  result: ArchiveResult;
  saveError?: string;
}

export interface ArchiveController {
  submit(
    url: string,
    reason: string,
    signal: AbortSignal,
    lastError?: string,
  ): Promise<void>;
  stats(): { submitted: number; skipped: number; failed: number };
  reset(): void;
  getEntries(): ReadonlyArray<ArchiveEntry>;
}

interface ArchiverConfig {
  enabled: boolean;
  maxPerRun: number;
  minIntervalMs: number;
  saveTimeoutMs: number;
  waybackBaseUrl: string;
  logFile: string;
  maxLogEntries: number;
}

const DEFAULT_CONFIG: ArchiverConfig = {
  enabled: true,
  maxPerRun: 25,
  minIntervalMs: 15_000,
  saveTimeoutMs: 15_000,
  waybackBaseUrl: "https://web.archive.org",
  logFile: path.join(
    os.homedir(),
    ".deep-swarm-research",
    "archives.json",
  ),
  maxLogEntries: 500,
};

/**
 * Create an archive controller. Each research run should `create` its own
 * controller (fresh dedup set + per-run counters) via `createArchiveController`
 * and call `.reset()` at the start of the run.
 */
export function createArchiveController(
  overrides: Partial<ArchiverConfig> = {},
): ArchiveController {
  const config: ArchiverConfig = { ...DEFAULT_CONFIG, ...overrides };
  const seen = new Set<string>();
  let submitted = 0;
  let skipped = 0;
  let failed = 0;
  let lastSubmitAt = 0;
  let logEntries: ArchiveEntry[] = [];

  function dedupeKey(url: string): string {
    try {
      const u = new URL(url);
      return `${u.hostname.toLowerCase()}${u.pathname}`;
    } catch {
      return url.toLowerCase();
    }
  }

  function appendLog(entry: ArchiveEntry, entries: ArchiveEntry[]): ArchiveEntry[] {
    const next = [...entries, entry].slice(-config.maxLogEntries);
    try {
      fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
      fs.writeFileSync(
        config.logFile,
        JSON.stringify(
          { plugin: "deep-swarm-research", version: 1, archives: next },
          null,
          2,
        ),
        "utf-8",
      );
    } catch {
      // Local log is best-effort; failure to write must never break research.
    }
    return next;
  }

  return {
    async submit(url: string, reason: string, signal: AbortSignal, lastError?: string) {
      if (!config.enabled || signal.aborted || !url) return;

      const key = dedupeKey(url);
      if (seen.has(key)) return; // dedupe: one submission per URL per run
      if (submitted >= config.maxPerRun) {
        skipped++;
        return;
      }
      seen.add(key);

      // Enforce a minimum gap between submissions (politeness).
      const now = Date.now();
      const waitMs = lastSubmitAt === 0 ? 0 : Math.max(0, config.minIntervalMs - (now - lastSubmitAt));
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
        if (signal.aborted) {
          skipped++;
          return;
        }
      }
      lastSubmitAt = Date.now();
      submitted++;

      const entry: ArchiveEntry = {
        archivedAt: new Date().toISOString(),
        url,
        reason,
        lastError,
        result: "skipped",
      };

      const saveUrl = `${config.waybackBaseUrl}/save/${encodeURIComponent(url)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.saveTimeoutMs);
      const onExternalAbort = () => controller.abort();
      signal.addEventListener("abort", onExternalAbort);

      try {
        const resp = await fetch(saveUrl, {
          method: "POST",
          redirect: "follow",
          signal: controller.signal,
        });
        if (resp.ok || resp.status === 302 || resp.status === 303) {
          entry.result = "submitted";
        } else if (resp.status === 429) {
          entry.result = "rate-limited";
        } else {
          entry.result = "failed";
          entry.saveError = `HTTP ${resp.status}`;
        }
      } catch (err) {
        if (controller.signal.aborted) {
          entry.result = "skipped";
        } else {
          entry.result = "failed";
          entry.saveError = err instanceof Error ? err.message : String(err);
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onExternalAbort);
      }

      logEntries = appendLog(entry, logEntries);
      if (entry.result === "submitted") {
        // Success; nothing further to do - log entry already recorded.
      } else if (entry.result !== "skipped") {
        failed++;
      }
    },
    stats() {
      return { submitted, skipped, failed };
    },
    reset() {
      seen.clear();
      submitted = 0;
      skipped = 0;
      failed = 0;
      lastSubmitAt = 0;
    },
    getEntries() {
      return logEntries.slice();
    },
  };
}