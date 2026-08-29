import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addDetachedWorktreeFromBranch,
  addReferenceSnapshotFromBranch,
  addWorktreeFromBranch,
  fetchBranch,
  fetchMirror,
  REFERENCE_GIT_TIMEOUT_MS,
  removeWorktree,
} from "./git.ts";
import { localRunner } from "../fleet/runner.ts";
import type { Runner } from "../fleet/runner.ts";

// --- unit: pin the refspecs (the whole fix is "write the tracking ref, never the
// local head", so the refspec target is the contract worth guarding) ----------

function fakeRunner(outputFor: (args: string[]) => string = () => "") {
  const calls: { file: string; args: string[]; opts?: any }[] = [];
  const runner = {
    kind: "local", dataDir: "/tmp",
    exec: async (file: string, args: string[], opts?: any) => {
      calls.push({ file, args, opts });
      return outputFor(args);
    },
    async mkdirp() {}, async exists() { return false; }, async rmrf() {},
    async putDir() {}, async putFile() {},
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
  assert.match(fetch!.opts.env.GIT_SSH_COMMAND, /ServerAliveInterval=15/);
  assert.equal(fetch!.opts.env.GIT_TERMINAL_PROMPT, "0");
});

test("reference snapshots bound every Git phase on the owner node", async () => {
  const commit = "a".repeat(40);
  const { runner, calls } = fakeRunner((args) => args[0] === "rev-parse" ? commit : "");
  await addReferenceSnapshotFromBranch(runner, "/m.git", "/task/.tdsp/refs/api", "main");
  const gitCalls = calls.filter((call) => call.file === "git");
  assert.ok(gitCalls.length >= 3);
  assert.ok(gitCalls.every((call) => call.opts.timeoutMs === REFERENCE_GIT_TIMEOUT_MS));
  assert.ok(
    gitCalls.some((call) => call.args[0] === "worktree" && call.args[1] === "add" && call.args.includes("--detach")),
    "snapshot export uses checkout's batched missing-blob prefetch",
  );
  assert.equal(
    gitCalls.some((call) => call.args.includes("checkout-index")),
    false,
    "snapshot export must not lazily fetch one blob at a time through checkout-index",
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

test("reference worktrees are detached and remain pinned to the resolved commit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sw-git-ref-"));
  try {
    const { seed, mirror } = await scaffold(root);
    const expected = (await git(seed, "rev-parse", "feat/base")).trim();
    const wtReference = path.join(root, "refs", "api");

    const resolved = await addDetachedWorktreeFromBranch(localRunner, mirror, wtReference, "feat/base");
    assert.equal(resolved, expected);
    assert.equal(await headOf(wtReference), "HEAD", "a reference does not claim a branch");
    assert.equal((await git(wtReference, "rev-parse", "HEAD")).trim(), expected);
    assert.equal(fs.readFileSync(path.join(wtReference, "b.txt"), "utf8"), "b");

    fs.writeFileSync(path.join(seed, "c.txt"), "new remote tip");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "advance");
    await git(seed, "push", "origin", "feat/base");
    assert.equal(
      (await git(wtReference, "rev-parse", "HEAD")).trim(),
      expected,
      "the task keeps the exact snapshot it was dispatched with",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("task-local reference snapshots are atomically exported without Git metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sw-git-snapshot-"));
  try {
    const { seed, mirror } = await scaffold(root);
    fs.writeFileSync(path.join(seed, ".gitattributes"), "b.txt export-ignore\n");
    await git(seed, "add", ".gitattributes");
    await git(seed, "commit", "-m", "archive attributes");
    await git(seed, "push", "origin", "feat/base");
    const expected = (await git(seed, "rev-parse", "feat/base")).trim();
    const taskWorktree = path.join(root, "worktrees", "1-7");
    const snapshot = path.join(taskWorktree, ".tdsp", "refs", "api");

    const resolved = await addReferenceSnapshotFromBranch(localRunner, mirror, snapshot, "feat/base");
    assert.equal(resolved, expected);
    assert.equal(
      fs.readFileSync(path.join(snapshot, "b.txt"), "utf8"),
      "b",
      "a reference includes tracked files even when Git archives would export-ignore them",
    );
    assert.equal(fs.existsSync(path.join(snapshot, ".git")), false, "a Ref is a plain code snapshot");
    assert.equal(
      (await git(mirror, "worktree", "list", "--porcelain")).includes(".tmp-api-"),
      false,
      "the temporary linked-worktree registration is pruned",
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(snapshot)).filter((name) => name.startsWith(".tmp-")),
      [],
      "temporary indexes and directories are removed after publication",
    );

    fs.writeFileSync(path.join(seed, "c.txt"), "new remote tip");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "advance snapshot source");
    await git(seed, "push", "origin", "feat/base");
    assert.equal(fs.existsSync(path.join(snapshot, "c.txt")), false, "the published Ref stays commit-pinned");

    await removeWorktree(localRunner, mirror, snapshot);
    assert.equal(fs.existsSync(snapshot), false, "normal task cleanup also removes plain snapshots");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reference snapshots batch-hydrate a cold blobless mirror", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sw-git-partial-ref-"));
  try {
    const { origin, seed, mirror } = await scaffold(root);
    await git(origin, "config", "uploadpack.allowFilter", "true");
    await git(mirror, "remote", "set-url", "origin", `file://${origin}`);

    const files = path.join(seed, "batch");
    fs.mkdirSync(files);
    for (let index = 0; index < 24; index++) {
      fs.writeFileSync(path.join(files, `${index}.txt`), `unique blob ${index}\n`);
    }
    await git(seed, "add", "batch");
    await git(seed, "commit", "-m", "add batch hydration fixture");
    await git(seed, "push", "origin", "feat/base");

    await fetchBranch(localRunner, mirror, "feat/base");
    assert.equal((await git(mirror, "config", "--get", "remote.origin.partialclonefilter")).trim(), "blob:none");
    const missingBlob = (await git(seed, "rev-parse", "feat/base:batch/0.txt")).trim();
    await assert.rejects(
      localRunner.exec("git", ["cat-file", "-e", missingBlob], {
        cwd: mirror,
        env: { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
      }),
      "the fixture mirror must start without the referenced file blobs",
    );

    const packDir = path.join(mirror, "objects", "pack");
    const packCount = () => fs.readdirSync(packDir).filter((name) => name.endsWith(".pack")).length;
    const before = packCount();
    const snapshot = path.join(root, "task", ".tdsp", "refs", "api");
    await addReferenceSnapshotFromBranch(localRunner, mirror, snapshot, "feat/base");
    const addedPacks = packCount() - before;

    assert.equal(fs.readFileSync(path.join(snapshot, "batch", "23.txt"), "utf8"), "unique blob 23\n");
    assert.ok(
      addedPacks <= 2,
      `normal checkout should batch missing blobs instead of creating one promisor pack per file (added ${addedPacks})`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
