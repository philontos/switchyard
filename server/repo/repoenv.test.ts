import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import { buildRepoTaskEnv } from "./repoenv.ts";
import type { Runner } from "../fleet/runner.ts";
import type { AgentKind } from "../session/agent.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

// A Runner double that records the hooks overlay and swallows the git worktree
// commands. This lets us assert which agents receive .claude settings.
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

function setupWith(agent: AgentKind, runner: Runner) {
  const db = new Database(":memory:");
  initSchema(db, opts);
  const env = buildRepoTaskEnv({ db, ns: "ns", runner, writeManifest: () => {} });
  return env.setupWorktree({
    id: 1, mirror: "/m", worktree: "/wt", workBranch: "feat/1-x", baseBranch: "main",
    agent,
  } as any);
}

test("setupWorktree (claude) injects the .claude hooks overlay", async () => {
  const { runner, putDirs } = recordingRunner();
  await setupWith("claude", runner);
  assert.deepEqual(putDirs.map((p) => p.dest), [path.join("/wt", ".claude")]);
});

// Codex and Kimi have no equivalent hook mechanism, so Switchyard cannot see
// their approval pauses.
test("setupWorktree (codex) skips Claude hooks", async () => {
  const { runner, putDirs } = recordingRunner();
  await setupWith("codex", runner);
  assert.equal(putDirs.length, 0);
});

test("setupWorktree (kimi) skips Claude hooks", async () => {
  const { runner, putDirs } = recordingRunner();
  await setupWith("kimi", runner);
  assert.equal(putDirs.length, 0);
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
