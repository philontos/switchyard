import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchBranch, fetchMirror, addWorktreeFromBranch } from "./git.ts";
import { localRunner } from "./runner.ts";
import type { Runner } from "./runner.ts";

// --- unit: pin the refspecs (the whole fix is "write the tracking ref, never the
// local head", so the refspec target is the contract worth guarding) ----------

function fakeRunner() {
  const calls: { file: string; args: string[] }[] = [];
  const runner = {
    kind: "local", dataDir: "/tmp",
    exec: async (file: string, args: string[]) => { calls.push({ file, args }); return ""; },
    async mkdirp() {}, async exists() { return false; }, async rmrf() {},
    async putDir() {}, async putFile() {},
    ptySpec(file: string, args: string[]) { return { file, args }; },
  } as unknown as Runner;
  return { runner, calls };
}

test("fetchBranch writes the remote-tracking ref, never the checked-out local head", async () => {
  const { runner, calls } = fakeRunner();
  await fetchBranch(runner, "/m.git", "feat/10-explore");
  // the contract is the refspec DESTINATION: refs/remotes/origin/* is never checked
  // out by a worktree, so force-updating it can't collide with a live task that has
  // feat/10-explore out. (Asserted independently of the blobless/shallow fetch flag.)
  const fetch = calls.find((c) => c.args[0] === "fetch");
  assert.ok(fetch, "expected a git fetch");
  assert.ok(
    fetch!.args.includes("+refs/heads/feat/10-explore:refs/remotes/origin/feat/10-explore"),
    "fetchBranch must map the branch into refs/remotes/origin/*",
  );
  assert.ok(
    !fetch!.args.some((a) => a.endsWith(":refs/heads/feat/10-explore")),
    "fetchBranch must NOT write the local head refs/heads/<branch>",
  );
});

test("fetchMirror refreshes into the remote-tracking namespace (prune), not local heads", async () => {
  const { runner, calls } = fakeRunner();
  await fetchMirror(runner, "/m.git", "https://example.com/r.git", null);
  const fetch = calls.find((c) => c.args[0] === "fetch");
  assert.ok(fetch, "expected a git fetch");
  assert.ok(fetch!.args.includes("--prune"), "manual refresh prunes");
  assert.ok(
    fetch!.args.includes("+refs/heads/*:refs/remotes/origin/*"),
    "fetchMirror must map all heads into refs/remotes/origin/*",
  );
  assert.ok(
    !fetch!.args.includes("+refs/heads/*:refs/heads/*"),
    "fetchMirror must NOT write local heads",
  );
});

// --- integration (real git): the reported bug + its fallback -------------------

// run a real git command in a real repo; identity via env so no global config needed
async function git(cwd: string, ...args: string[]): Promise<string> {
  return localRunner.exec("git", args, {
    cwd,
    env: {
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}
const headOf = async (wt: string) => (await git(wt, "rev-parse", "--abbrev-ref", "HEAD")).trim();

// origin.git (bare) + a mirror with `origin` configured, plus `main` and an extra
// branch already pushed. Returns the dir paths; caller removes `root` when done.
async function scaffold(root: string) {
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const mirror = path.join(root, "mirror.git");
  await git(root, "init", "--bare", origin);
  await git(root, "init", "-b", "main", seed);
  fs.writeFileSync(path.join(seed, "a.txt"), "a");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "init");
  await git(seed, "remote", "add", "origin", origin);
  await git(seed, "push", "origin", "main");
  await git(seed, "checkout", "-b", "feat/base");
  fs.writeFileSync(path.join(seed, "b.txt"), "b");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "b");
  await git(seed, "push", "origin", "feat/base");
  await git(root, "init", "--bare", mirror);
  await git(mirror, "remote", "add", "origin", origin);
  return { origin, seed, mirror };
}

test("can create a task whose base branch is already checked out in another worktree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sw-git-"));
  try {
    const { mirror } = await scaffold(root);
    // simulate task 10: its work branch feat/base lives as a LOCAL head, checked
    // out in its worktree (this is exactly what makes the old force-fetch fail).
    await git(mirror, "fetch", "--depth", "1", "origin", "+refs/heads/feat/base:refs/heads/feat/base");
    const wtExisting = path.join(root, "wt-existing");
    await git(mirror, "worktree", "add", wtExisting, "feat/base");

    // new task off that same, currently-checked-out branch — must NOT throw
    const wtNew = path.join(root, "wt-new");
    await addWorktreeFromBranch(localRunner, mirror, wtNew, "feat/99-new", "feat/base");

    assert.ok(fs.existsSync(wtNew), "new worktree was created");
    assert.equal(await headOf(wtNew), "feat/99-new", "new worktree is on its own work branch");
    assert.equal(await headOf(wtExisting), "feat/base", "the existing task's worktree is untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to the local head when the base branch is not on origin (unpushed)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sw-git-"));
  try {
    const { mirror } = await scaffold(root);
    // a purely-local branch (never pushed): branch off another task's unpushed work
    await git(mirror, "fetch", "--depth", "1", "origin", "+refs/heads/main:refs/heads/main");
    await git(mirror, "branch", "feat/local-only", "main");
    const wtLocal = path.join(root, "wt-local");
    await git(mirror, "worktree", "add", wtLocal, "feat/local-only");

    const wtNew = path.join(root, "wt-new2");
    await addWorktreeFromBranch(localRunner, mirror, wtNew, "feat/100-x", "feat/local-only");

    assert.ok(fs.existsSync(wtNew), "new worktree was created from the local head");
    assert.equal(await headOf(wtNew), "feat/100-x");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
