import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Read-through skill aggregation: no physical library. We scan a set of
// read-only source roots ON THE CONTROLLER and list whatever skills are there,
// tagged by source. Identity is `source:name` (different sources may reuse a
// name). The only copy happens at dispatch time (server/index.ts uses resolve +
// Runner.putDir to drop a skill's whole dir into the task worktree).

export interface SkillSource { source: string; root: string; }
export interface SkillEntry { key: string; name: string; description: string; source: string; dir: string; }

/** The dispatcher's private skill library, on the controller. Deliberately does
 *  NOT scan the user's ~/.claude: a LOCAL task's claude already discovers those
 *  natively (user-level), so injecting them would be redundant; and a REMOTE
 *  task should get a curated, dispatcher-owned set, not whatever happens to sit
 *  in the operator's personal config. Populate this by hand
 *  (~/.task-dispatcher/skills) or via official-marketplace installs (plugins.ts)
 *  into the isolated config. */
export function defaultSources(home = os.homedir()): SkillSource[] {
  return [
    { source: "dispatcher", root: path.join(home, ".task-dispatcher", "skills") },
    // official-marketplace installs land here (CLAUDE_CONFIG_DIR=<DATA_DIR>/claude-config)
    { source: "dispatcher", root: path.join(home, ".task-dispatcher", "claude-config", "plugins", "cache") },
  ];
}

/** A skill = a directory directly containing SKILL.md. Recurse until found; do
 *  not descend into a skill (its subdirs are its own files/scripts). */
function findSkillDirs(root: string, acc: string[] = [], depth = 0): string[] {
  if (depth > 8 || !fs.existsSync(root)) return acc;
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  if (ents.some((e) => e.isFile() && e.name === "SKILL.md")) { acc.push(root); return acc; }
  for (const e of ents) if (e.isDirectory()) findSkillDirs(path.join(root, e.name), acc, depth + 1);
  return acc;
}

/** Minimal frontmatter read — single-line name/description, quotes stripped. */
function frontmatter(file: string): { name?: string; description?: string } {
  let txt = "";
  try { txt = fs.readFileSync(file, "utf8"); } catch { return {}; }
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function scanSkills(sources: SkillSource[]): SkillEntry[] {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const { source, root } of sources) {
    for (const dir of findSkillDirs(root)) {
      const fm = frontmatter(path.join(dir, "SKILL.md"));
      const name = fm.name || path.basename(dir);
      const key = `${source}:${name}`;
      if (seen.has(key)) continue;          // first occurrence per source:name wins
      seen.add(key);
      out.push({ key, name, description: fm.description || "", source, dir });
    }
  }
  return out;
}

export function resolveSkills(keys: string[], sources: SkillSource[]): { found: SkillEntry[]; missing: string[] } {
  const byKey = new Map(scanSkills(sources).map((s) => [s.key, s]));
  const found: SkillEntry[] = [], missing: string[] = [];
  for (const k of keys) { const s = byKey.get(k); s ? found.push(s) : missing.push(k); }
  return { found, missing };
}

/** The "本任务已带入 skills: …" line appended to a task's opening message so the
 *  user and Claude both see what was delivered. Empty when nothing was. */
export function skillsLine(names: string[]): string {
  return names.length ? `\n\n本任务已带入 skills: ${names.join(", ")}` : "";
}
