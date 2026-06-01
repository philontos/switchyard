import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSkills, resolveSkills, SkillSource } from "./skills.ts";

function mkSkill(root: string, name: string, desc: string) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`);
  return d;
}

test("scanSkills lists skills with source-qualified keys + descriptions", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sk-"));
  const localRoot = path.join(tmp, "local");            // disjoint roots, as in reality
  const pluginRoot = path.join(tmp, "plugin");
  mkSkill(localRoot, "alpha", "first one");
  mkSkill(path.join(pluginRoot, "mkt", "plug", "1.0", "skills"), "beta", "deep one"); // plugin-cache depth
  const sources: SkillSource[] = [
    { source: "local", root: localRoot },
    { source: "plugin", root: pluginRoot },
  ];
  const got = scanSkills(sources).map(s => ({ key: s.key, name: s.name, description: s.description }));
  assert.deepEqual(got.sort((a, b) => a.key.localeCompare(b.key)), [
    { key: "local:alpha", name: "alpha", description: "first one" },
    { key: "plugin:beta", name: "beta", description: "deep one" },
  ]);
});

test("resolveSkills returns found dirs and reports missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sk-"));
  const dir = mkSkill(tmp, "alpha", "x");
  const sources: SkillSource[] = [{ source: "local", root: tmp }];
  const r = resolveSkills(["local:alpha", "local:ghost"], sources);
  assert.equal(r.found.length, 1);
  assert.equal(r.found[0].dir, dir);
  assert.deepEqual(r.missing, ["local:ghost"]);
});

test("missing root is skipped, not thrown", () => {
  const r = scanSkills([{ source: "local", root: "/no/such/dir/xyz" }]);
  assert.deepEqual(r, []);
});
