// src/skills/loader.ts
// Skill-pack loader (item 8). Bundled AGENTS.md-style packs ship read-only in
// `<package root>/skills`; users may override any pack (or add their own) under
// `~/.deep-swarm-research/skills/`. The override dir always wins. Packs carry
// YAML-ish frontmatter (`name`, `version`, `domains`, `description`) so the
// planner can auto-select a pack from its domain tags and log the resolved
// pack+version in the report footer.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SkillPack } from "../types";

export interface Skill {
  name: string;
  filePath: string;
  description: string;
}

export interface SkillPackIndex {
  readonly name: string;
  readonly filePath: string;
  readonly userOverride: boolean;
  readonly content: string;
}

const OVERRIDE_DIR = path.join(os.homedir(), ".deep-swarm-research", "skills");

// Deterministic bundle path: works both from `src/skills` (tsc/tsx) and from
// `dist/skills` (built package) — never depends on process.cwd().
const BUNDLED_DIR = path.resolve(__dirname, "..", "..", "skills");

function readJsonishFrontmatter(
  content: string,
): { front: Record<string, unknown>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return null;
  const front: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (!key || !raw) continue;
    if (raw.startsWith("[") && raw.endsWith("]")) {
      front[key] = raw
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else if (/^\d+$/.test(raw)) {
      front[key] = parseInt(raw, 10);
    } else {
      front[key] = raw.replace(/^["']|["']$/g, "");
    }
  }
  return { front, body: content.slice(m[0].length) };
}

function asStringArray(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

function toSkillPack(
  name: string,
  filePath: string,
  userOverride: boolean,
  content: string,
): SkillPack | null {
  const parsed = readJsonishFrontmatter(content);
  const front = parsed?.front ?? {};
  const body = parsed?.body ?? content;
  return {
    name: typeof front.name === "string" && front.name ? front.name : name,
    version: String(front.version ?? 1),
    domainTags: asStringArray(front.domains ?? front.domainTags),
    description:
      typeof front.description === "string" ? front.description : name,
    content: body.trim(),
    filePath,
    userOverride,
  };
}

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function listPackFiles(): ReadonlyArray<SkillPackIndex> {
  const packs: SkillPackIndex[] = [];
  const seen = new Set<string>();

  for (const dir of [OVERRIDE_DIR, BUNDLED_DIR]) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".txt"));
    } catch {
      continue;
    }
    for (const file of files) {
      const base = file.replace(/\.(md|txt)$/i, "");
      if (seen.has(base)) continue;
      const filePath = path.join(dir, file);
      const content = readFileIfExists(filePath);
      if (content === null) continue;
      seen.add(base);
      packs.push({
        name: base,
        filePath,
        userOverride: dir === OVERRIDE_DIR,
        content,
      });
    }
  }
  return packs;
}

export function listSkillPacks(): ReadonlyArray<SkillPack> {
  const packs: SkillPack[] = [];
  for (const idx of listPackFiles()) {
    const pack = toSkillPack(idx.name, idx.filePath, idx.userOverride, idx.content);
    if (pack) packs.push(pack);
  }
  return packs;
}

// Restrict pack names to plain identifiers so a hostile caller cannot traverse
// out of the skills dirs via `readSkillFile("../../secret")`.
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;

function sanitizeSkillName(name: string): string {
  const cleaned = name.replace(/\.(md|txt)$/i, "").trim();
  if (!cleaned) return "";
  if (cleaned.includes("..") || /[\\/]/.test(cleaned)) return "";
  if (!SKILL_NAME_RE.test(cleaned)) return "";
  return cleaned;
}

/** Resolves one pack by name and parses it; returns null when missing/broken. */
export function loadSkillPack(name: string): SkillPack | null {
  const cleaned = sanitizeSkillName(name);
  if (!cleaned) return null;
  for (const idx of listPackFiles()) {
    if (idx.name.toLowerCase() === cleaned.toLowerCase()) {
      return toSkillPack(idx.name, idx.filePath, idx.userOverride, idx.content);
    }
  }
  return null;
}

/** Back-compat listing used by the ReadSkillFile tool. */
export function loadSkills(): Skill[] {
  return listSkillPacks().map((p) => ({
    name: p.name,
    filePath: p.filePath,
    description: p.description.slice(0, 100),
  }));
}

/**
 * Reads a pack's raw markdown (frontmatter + body). Override dir wins over the
 * bundled pack. Returns null when the pack is not installed anywhere.
 */
export function readSkillFile(name: string): string | null {
  const cleaned = sanitizeSkillName(name);
  if (!cleaned) return null;
  for (const suffix of [".md", ".txt"]) {
    const overridePath = path.join(OVERRIDE_DIR, `${cleaned}${suffix}`);
    const overrideContent = readFileIfExists(overridePath);
    if (overrideContent !== null) return overrideContent;
  }
  for (const suffix of [".md", ".txt"]) {
    const bundledPath = path.join(BUNDLED_DIR, `${cleaned}${suffix}`);
    const bundledContent = readFileIfExists(bundledPath);
    if (bundledContent !== null) return bundledContent;
  }
  return null;
}

export { BUNDLED_DIR, OVERRIDE_DIR };