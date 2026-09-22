// src/skills/select.ts
// Auto-selects the best skill pack for a research topic from the planner's
// domain tags (item 8). Matching is deterministic and tag-overlap based; when
// no pack matches, the run proceeds without a skill pack (footer reports none).
import { SkillPack } from "../types";
import { listSkillPacks } from "./loader";

export function selectSkillForTags(
  domainTags: ReadonlyArray<string>,
): SkillPack | null {
  const tags = domainTags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length === 0) return null;

  let best: SkillPack | null = null;
  let bestScore = 0;
  for (const pack of listSkillPacks()) {
    const packTags = pack.domainTags.map((t) => t.toLowerCase());
    let score = 0;
    for (const tag of tags) {
      if (packTags.includes(tag)) score += 2;
      else if (packTags.some((pt) => tag.includes(pt) || pt.includes(tag))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = pack;
    }
  }
  return bestScore > 0 ? best : null;
}

export function skillLabel(pack: SkillPack | null, tags: ReadonlyArray<string>): string {
  if (pack) return `${pack.name} v${pack.version}`;
  return tags.length > 0 ? "none (no matching skill pack)" : "none (no domain tags)";
}