import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const PRIMARY_LOG_DIR = path.join("D:", "logs", "deep-swarm-research");
const FALLBACK_LOG_DIR = path.join(os.homedir(), ".deep-swarm-research", "logs");

let LOG_DIR = PRIMARY_LOG_DIR;
let LOG_FILE = path.join(LOG_DIR, "plugin.log");
let initialized = false;

function ensureDir() {
  if (initialized) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, "");
    console.log(`[Logger] Successfully initialized log file at: ${LOG_FILE}`);
  } catch {
    console.warn(`[Logger] D: drive blocked, falling back to ${FALLBACK_LOG_DIR}`);
    LOG_DIR = FALLBACK_LOG_DIR;
    LOG_FILE = path.join(LOG_DIR, "plugin.log");
    mkdirSync(LOG_DIR, { recursive: true });
  }
  initialized = true;
}

export function log(message: string) {
  try {
    ensureDir();
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // silent fail
  }
}

export function logCacheMetrics(metrics: { hits: number; misses: number; size: number }) {
  log(`CACHE_METRICS hits=${metrics.hits} misses=${metrics.misses} size=${metrics.size}`);
}