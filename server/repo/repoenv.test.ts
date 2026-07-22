import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import { buildRepoTaskEnv } from "./repoenv.ts";
import type { Runner } from "../fleet/runner.ts";
import type { AgentKind } from "../session/agent.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

// A Runner double that records every putDir (skill delivery + the hooks overlay
// both go through putDir) and swallows exec (the git worktree commands). This
// lets us assert exactly which .claude/* injections happened per agent.
function recordingRunner() {
  const putDirs: { src: string; dest: string }[] = [];
  const runner = {
    kind: "local", dataDir: "/tmp",
    exec: async (_file: string, args: string[]) => args[0] === "rev-parse" ? "a".repeat(40) + "\n" : "",
    mkdirp: async () => {}, exists: async () => false, readText: async () => null,
    rmrf: async () => {}, putFile: async () => {},
    putDir: async (src: string, dest: string) => { putDirs.push({ src, dest }); },
  } as unknown as Runner;
  return { runner, putDirs };
}

function setupWith(agent: AgentKind, putDirs: { src: string; dest: string }[], runner: Runner) {
  const db = new Database(":memory:");
  initSchema(db, opts);
  const env = buildRepoTaskEnv({ db, ns: "ns", runner, writeManifest: () => {} });
  return env.setupWorktree({
    id: 1, mirror: "/m", worktree: "/wt", workBranch: "feat/1-x", baseBranch: "main",
    skills: [{ key: "d:tdd", name: "tdd", dir: "/skills/tdd" }], agent,
  } as any);
}

// claude keeps its .claude/ conventions: the skill dir is delivered and the
// waiting-hook overlay is injected. (Regression guard for existing behavior.)
test("setupWorktree (claude) delivers skills and injects the .claude hooks overlay", async () => {
  const { runner, putDirs } = recordingRunner();
  await setupWith("claude", putDirs, runner);
  assert.ok(putDirs.some((p) => p.dest === path.join("/wt", ".claude", "skills", "tdd")), "skill delivered");
  assert.ok(putDirs.some((p) => p.dest === path.join("/wt", ".claude")), "hooks overlay delivered");
});

// codex has no .claude/skills and no hook mechanism, so neither injection runs —
// zero putDir calls. It also has no waiting-hook (the dispatcher can't see a
// codex approval pause — see agentArgv).
test("setupWorktree (codex) skips skills and hooks — no .claude injection at all", async () => {
  const { runner, putDirs } = recordingRunner();
  await setupWith("codex", putDirs, runner);
  assert.equal(putDirs.length, 0, "codex delivers no skills and injects no hooks");
});

test("setupWorktree (kimi) skips skills and hooks — no .claude injection at all", async () => {
  const { runner, putDirs } = recordingRunner();
  await setupWith("kimi", putDirs, runner);
  assert.equal(putDirs.length, 0, "kimi delivers no skills and injects no hooks");
});

test("buildRepoTaskEnv refuses a remote runner", () => {
  const db = new Database(":memory:");
  initSchema(db, opts);
  const { runner } = recordingRunner();
  (runner as any).kind = "ssh";
  assert.throws(
    () => buildRepoTaskEnv({ db, ns: "ns", runner, writeManifest: () => {} }),
    /owning node/,
  );
});
