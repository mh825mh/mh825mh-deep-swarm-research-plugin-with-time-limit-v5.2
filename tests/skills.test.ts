import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSkillPack,
  listSkillPacks,
  readSkillFile,
  OVERRIDE_DIR,
} from "../src/skills/loader";
import { selectSkillForTags, skillLabel } from "../src/skills/select";

describe("bundled skill packs", () => {
  it("loads the academic pack with frontmatter parsed", () => {
    const pack = loadSkillPack("academic");
    expect(pack).not.toBeNull();
    expect(pack!.name).toBe("academic");
    expect(pack!.domainTags.length).toBeGreaterThan(3);
    expect(pack!.content).toContain("Source hierarchy");
  });

  it("lists at least the three bundled packs", () => {
    const names = listSkillPacks().map((p) => p.name);
    for (const expected of ["academic", "policy", "market"]) {
      expect(names).toContain(expected);
    }
  });

  it("reads the raw markdown file (frontmatter included)", () => {
    const raw = readSkillFile("market");
    expect(raw).toContain("---");
    expect(raw).toContain("Business Research Skill Pack");
  });

  it("rejects names that traverse outside the skills dir", () => {
    expect(readSkillFile("../../package.json")).toBeNull();
    expect(readSkillFile("..\\..\\package.json")).toBeNull();
    expect(readSkillFile("foo/bar")).toBeNull();
    expect(loadSkillPack("package.json")).toBeNull();
    expect(loadSkillPack("")).toBeNull();
  });
});

describe("selectSkillForTags", () => {
  it("selects the academic pack for medical/science tags", () => {
    const pack = selectSkillForTags(["medicine", "clinical"]);
    expect(pack?.name).toBe("academic");
  });

  it("selects the policy pack for regulatory tags", () => {
    const pack = selectSkillForTags(["regulation"]);
    expect(pack?.name).toBe("policy");
  });

  it("returns null for unrelated tags", () => {
    expect(selectSkillForTags(["gardening", "cooking"])).toBeNull();
    expect(selectSkillForTags([])).toBeNull();
  });
});

describe("skillLabel", () => {
  it("renders pack label and none-labels", () => {
    expect(skillLabel(null, [])).toContain("no domain tags");
    expect(skillLabel(null, ["x"])).toContain("no matching skill pack");
    expect(skillLabel({ name: "academic", version: "1", domainTags: [], description: "", content: "", filePath: "", userOverride: false }, [])).toBe("academic v1");
  });
});

describe("override dir precedence", () => {
  const overrideFile = path.join(OVERRIDE_DIR, "academic.md");
  const backup: string | null = fs.existsSync(overrideFile)
    ? fs.readFileSync(overrideFile, "utf-8")
    : null;

  afterAll(() => {
    if (backup !== null) {
      fs.mkdirSync(OVERRIDE_DIR, { recursive: true });
      fs.writeFileSync(overrideFile, backup);
    } else {
      try {
        fs.rmSync(overrideFile, { force: true });
      } catch {
        /* non-fatal cleanup */
      }
    }
  });

  it("an override file shadows the bundled pack", () => {
    fs.mkdirSync(OVERRIDE_DIR, { recursive: true });
    fs.writeFileSync(
      overrideFile,
      "---\nname: academic\nversion: 99\ndomains: [academic]\ndescription: override\n---\n\n# Override body",
    );
    const pack = loadSkillPack("academic");
    expect(pack?.version).toBe("99");
    expect(pack?.userOverride).toBe(true);
    expect(pack?.content).toContain("Override body");
  });
});