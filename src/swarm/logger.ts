import { mkdirSync } from "node:fs";
import fsp from "node:fs/promises"; // ADD THIS
import path from "node:path";
import os from "node:os";

// FIX: Use home directory for cross-platform compatibility (Mac/Linux/Windows)
const LOG_DIR = path.join(os.homedir(), ".deep-swarm-research", "logs");
const LOG_FILE = path.join(LOG_DIR, "plugin.log");
let initialized = false;

function ensureDir() {
  if (initialized) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    console.log(`[Logger] Successfully initialized log file at: ${LOG_FILE}`);
  } catch {
    console.error(`[Logger] Failed to create log directory: ${LOG_DIR}`);
  }
  initialized = true;
}

export function log(message: string) {
  ensureDir();
  const logLine = `[${new Date().toISOString()}] ${message}\n`;
  // FIX: Fire-and-forget async append to prevent blocking the event loop
  fsp.appendFile(LOG_FILE, logLine).catch(() => {});
}