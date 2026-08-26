// src/config/keys.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEYS_DIR = path.join(os.homedir(), ".deep-swarm-research");
const KEYS_FILE = path.join(KEYS_DIR, "api-keys.json");

export interface UserKeys {
  readonly serperApiKey?: string;
  readonly braveApiKey?: string;
}

function ensureTemplate(): void {
  try {
    if (fs.existsSync(KEYS_FILE)) return;
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    fs.writeFileSync(
      KEYS_FILE,
      JSON.stringify(
        {
          serperApiKey: "",
          braveApiKey: "",
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.error(`[keys] Created template keys file at ${KEYS_FILE}`);
  } catch {
    // Non-fatal
  }
}

export function loadUserKeys(): UserKeys {
  try {
    ensureTemplate();
    if (!fs.existsSync(KEYS_FILE)) return {};

    const raw = fs.readFileSync(KEYS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const cleanStr = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;

    return {
      serperApiKey: cleanStr(parsed.serperApiKey),
      braveApiKey: cleanStr(parsed.braveApiKey),
    };
  } catch (err) {
    console.error(
      `[keys] Failed to read ${KEYS_FILE}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {};
  }
}

export function keysFilePath(): string {
  return KEYS_FILE;
}