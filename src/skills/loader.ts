import fs from "node:fs";
import path from "node:path";

export interface Skill {
  name: string;
  filePath: string;
  description: string;
}

const SKILLS_DIR = path.resolve(process.cwd(), "skills");

export function loadSkills(): Skill[] {
  const skills: Skill[] = [];
  try {
    if (!fs.existsSync(SKILLS_DIR)) {
      fs.mkdirSync(SKILLS_DIR, { recursive: true });
      return [];
    }
    
    const files = fs.readdirSync(SKILLS_DIR);
    for (const file of files) {
      if (file.endsWith(".md") || file.endsWith(".txt")) {
        const filePath = path.join(SKILLS_DIR, file);
        const content = fs.readFileSync(filePath, "utf-8");
        
        // Extract the first H1 or first line as the description
        const firstLine = content.split("\n").find(l => l.trim().length > 0) ?? file;
        const desc = firstLine.replace(/^#\s*/, "").trim();
        
        skills.push({
          name: file.replace(/\.(md|txt)$/i, ""),
          filePath,
          description: desc.slice(0, 100),
        });
      }
    }
  } catch {
    // silent fail
  }
  return skills;
}

export function readSkillFile(name: string): string | null {
  try {
    const filePath = path.join(SKILLS_DIR, `${name}.md`);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8");
    
    const txtPath = path.join(SKILLS_DIR, `${name}.txt`);
    if (fs.existsSync(txtPath)) return fs.readFileSync(txtPath, "utf-8");
    
    return null;
  } catch {
    return null;
  }
}