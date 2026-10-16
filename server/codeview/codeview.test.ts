import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { Repo, Task } from "../core/db.ts";
import { initSchema } from "../core/schema.ts";
import type { ExecOpts, Runner } from "../fleet/runner.ts";
import {
  MAX_CODE_FILE_BYTES,
  inspectOwnedCode,
  inspectRepoCode,
  inspectTaskCode,
} from "./codeview.ts";

const pexec = promisify(execFile);

class TestRunner implements Runner {
  constructor(public kind: "local" | "ssh" = "local") {}
  dataDir = "/tmp";
  async exec(file: string, args: string[], opts: ExecOpts = {}) {
    const { stdout } = await pexec(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    });
    return stdout;
  }
  async mkdirp(dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  async exists(target: string) { return fs.existsSync(target); }
  async readText(target: string) { try { return fs.readFileSync(target, "utf8"); } catch { return null; } }
  async rmrf(target: string) { fs.rmSync(target, { recursive: true, force: true }); }
  async putDir(src: string, dest: string) { fs.cpSync(src, dest, { recursive: true }); }
  async putFile(src: string, dest: string) { fs.copyFileSync(src, dest); }
}

const runner = new TestRunner();
const remoteLikeRunner = new TestRunner("ssh");

async function git(cwd: string, ...args: string[]) {
  return (await runner.exec("git", args, { cwd })).trim();
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-codeview-"));
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, ".gitignore"), "secret.env\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n");
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "export const answer = 1;\n");
  fs.writeFileSync(path.join(dir, "src", "binary.bin"), Buffer.from([0, 1, 2, 3]));
  fs.symlinkSync("README.md", path.join(dir, "readme-link"));
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "base");
  const base = await git(dir, "rev-parse", "HEAD");

  const repo = {
    id: 1, host_id: 1, name: "demo", git_url: "", token: null,
    default_branch: "main", mirror_path: dir,
    status: "ready", error: null, created_at: "now",
  } satisfies Repo;
  const task = {
    id: 1, repo_id: 1, base_branch: "main", base_commit: base,
    work_branch: "feat/1-demo", title: "demo", prompt: null,
    worktree_path: dir, session: "tdsp-1", status: "running", error: null,
    created_at: "now", kind: "repo", host_id: 1, cwd: null,
    claude_session: null, provider_id: null, agent: "claude", agent_model: null,
  } satisfies Task;
  return { dir, base, repo, task };
}

async function remoteFixture() {
  const f = await fixture();
  const origin = path.join(f.dir, "origin.git");
  const mirror = path.join(f.dir, "mirror.git");
  await git(f.dir, "branch", "-m", "master");
  await git(f.dir, "init", "--bare", "-b", "master", origin);
  await git(f.dir, "remote", "add", "origin", origin);
  await git(f.dir, "push", "origin", "master");
  await git(f.dir, "init", "--bare", mirror);
  await git(mirror, "remote", "add", "origin", origin);
  return { ...f, origin, mirror, repo: { ...f.repo, mirror_path: mirror } };
}

test("repository preview recovers a legacy main default when origin only has master", async () => {
  const f = await remoteFixture();
  try {
    const tree = await inspectRepoCode(runner, f.repo, { operation: "tree" });
    assert.equal(tree.kind, "tree");
    if (tree.kind !== "tree") return;
    assert.ok(tree.files.includes("src/app.ts"));
    assert.deepEqual(tree.revision, { label: "master", commit: f.base });
    const file = await inspectRepoCode(runner, f.repo, { operation: "file", path: "src/app.ts" });
    assert.equal(file.kind, "file");
    if (file.kind === "file") assert.equal(file.content, "export const answer = 1;\n");
    assert.equal(await git(f.dir, "branch", "--show-current"), "master", "preview does not switch a worktree branch");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("refresh recovers a removed default even when its old tracking commit is cached", async () => {
  const f = await remoteFixture();
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/legacy", dataDir: f.dir });
  db.prepare("INSERT INTO hosts (id,name,target,kind) VALUES (1,'local','','local')").run();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,default_branch,mirror_path,status) VALUES (1,1,'demo',?,'main',?,'ready')")
    .run(f.origin, f.mirror);
  let syncs = 0;
  try {
    await git(f.mirror, "fetch", "origin", "+refs/heads/master:refs/remotes/origin/main");
    fs.writeFileSync(path.join(f.dir, "src", "app.ts"), "export const answer = 2;\n");
    await git(f.dir, "add", "src/app.ts");
    await git(f.dir, "commit", "-m", "advance master");
    await git(f.dir, "push", "origin", "master");
    const latest = await git(f.dir, "rev-parse", "HEAD");
    const tree = await inspectOwnedCode(db, runner, { scope: "repo", id: 1, operation: "tree", refresh: true }, () => { syncs++; });
    assert.equal(tree.ok, true);
    if (!tree.ok) return;
    assert.deepEqual(tree.revision, { label: "master", commit: latest });
    assert.equal(syncs, 1, "the repaired catalog is persisted to its manifest");
    assert.deepEqual(db.prepare("SELECT default_branch FROM repos WHERE id=1").get(), { default_branch: "master" });
    const file = await inspectOwnedCode(db, runner, { scope: "repo", id: 1, operation: "file", path: "src/app.ts" }, () => { syncs++; });
    assert.equal(file.ok, true);
    if (!file.ok || file.kind !== "file") return;
    assert.deepEqual(file.revision, { label: "master", commit: latest });
    assert.equal(file.content, "export const answer = 2;\n");
    assert.equal(syncs, 1);
  } finally { db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("repository preview preserves a valid configured branch different from remote HEAD", async () => {
  const f = await remoteFixture();
  try {
    await git(f.dir, "checkout", "-b", "release/stable");
    fs.writeFileSync(path.join(f.dir, "src", "app.ts"), "export const answer = 3;\n");
    await git(f.dir, "add", "src/app.ts");
    await git(f.dir, "commit", "-m", "release");
    await git(f.dir, "push", "origin", "release/stable");
    f.repo.default_branch = "release/stable";
    const file = await inspectRepoCode(runner, f.repo, { operation: "file", path: "src/app.ts" });
    assert.equal(file.kind, "file");
    if (file.kind !== "file") return;
    assert.equal(file.revision.label, "release/stable");
    assert.equal(file.content, "export const answer = 3;\n");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("cached repository and live task previews do not depend on remote branch discovery", async () => {
  const f = await fixture();
  const offline = new TestRunner();
  offline.exec = async (file, args, opts) => {
    assert.ok(!["fetch", "ls-remote"].includes(args[0]), "cached and task previews must not access origin");
    return runner.exec(file, args, opts);
  };
  try {
    assert.equal((await inspectRepoCode(offline, f.repo, { operation: "tree" })).kind, "tree");
    fs.writeFileSync(path.join(f.dir, "src", "app.ts"), "export const answer = 4;\n");
    f.repo.default_branch = "missing";
    assert.equal((await inspectTaskCode(offline, f.task, { operation: "tree" })).kind, "tree");
    const file = await inspectTaskCode(offline, f.task, { operation: "file", path: "src/app.ts" });
    assert.equal(file.kind, "file");
    if (file.kind === "file") assert.equal(file.content, "export const answer = 4;\n");
    assert.equal((await inspectTaskCode(offline, f.task, { operation: "changes" })).kind, "changes");
    assert.equal((await inspectTaskCode(offline, f.task, { operation: "diff", path: "src/app.ts" })).kind, "diff");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("repository view lists the committed structure and reads a text blob", async () => {
  const f = await fixture();
  try {
    const tree = await inspectRepoCode(runner, f.repo, { operation: "tree" });
    assert.equal(tree.kind, "tree");
    if (tree.kind !== "tree") return;
    assert.ok(tree.files.includes("src/app.ts"));
    assert.equal(tree.revision.commit, f.base);

    const file = await inspectRepoCode(runner, f.repo, { operation: "file", path: "src/app.ts" });
    assert.equal(file.kind, "file");
    if (file.kind !== "file") return;
    assert.equal(file.content, "export const answer = 1;\n");

    const binary = await inspectRepoCode(runner, f.repo, { operation: "file", path: "src/binary.bin" });
    assert.equal(binary.kind, "file");
    if (binary.kind === "file") assert.equal(binary.unavailable, "binary");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("code inspection refuses a remote runner so the owning node must handle it", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => inspectTaskCode(remoteLikeRunner, f.task, { operation: "file", path: "src/app.ts" }),
      (error: any) => error?.code === "ownerRequired",
    );
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("task view shows committed, dirty, deleted, and untracked changes against dispatch base", async () => {
  const f = await fixture();
  try {
    // Commit one task change to prove the preview does not incorrectly diff HEAD.
    fs.writeFileSync(path.join(f.dir, "src", "app.ts"), "export const answer = 2;\n");
    await git(f.dir, "add", "src/app.ts");
    await git(f.dir, "commit", "-m", "agent committed change");
    fs.rmSync(path.join(f.dir, "README.md"));
    fs.writeFileSync(path.join(f.dir, "src", "new.ts"), "export const fresh = true;\n");

    const changes = await inspectTaskCode(runner, f.task, { operation: "changes" });
    assert.equal(changes.kind, "changes");
    if (changes.kind !== "changes") return;
    assert.deepEqual(
      changes.files.map((x) => [x.status, x.path]),
      [["D", "README.md"], ["M", "src/app.ts"], ["?", "src/new.ts"]],
    );
    assert.equal(changes.revision.commit, f.base, "the immutable dispatch SHA is the diff baseline");

    const committed = await inspectTaskCode(runner, f.task, { operation: "diff", path: "src/app.ts" });
    assert.equal(committed.kind, "diff");
    if (committed.kind !== "diff") return;
    assert.match(committed.content || "", /answer = 1/);
    assert.match(committed.content || "", /answer = 2/);

    const added = await inspectTaskCode(runner, f.task, { operation: "diff", path: "src/new.ts" });
    assert.equal(added.kind, "diff");
    if (added.kind !== "diff") return;
    assert.match(added.content || "", /new file mode/);
    assert.match(added.content || "", /\+export const fresh = true/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("task file view exposes Git-visible text but not ignored files or traversal", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.dir, "secret.env"), "TOKEN=do-not-leak\n");
    const file = await inspectTaskCode(runner, f.task, { operation: "file", path: "src/app.ts" });
    assert.equal(file.kind, "file");
    if (file.kind === "file") assert.match(file.content || "", /answer/);
    await assert.rejects(
      () => inspectTaskCode(runner, f.task, { operation: "file", path: "secret.env" }),
      /visible worktree/,
    );
    await assert.rejects(
      () => inspectTaskCode(runner, f.task, { operation: "file", path: "../.git/config" }),
      /Invalid file path/,
    );
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("task file view refuses symlinks, binary files, and oversized text", async () => {
  const f = await fixture();
  try {
    const link = await inspectTaskCode(runner, f.task, { operation: "file", path: "readme-link" });
    assert.equal(link.kind, "file");
    if (link.kind === "file") assert.equal(link.unavailable, "symlink");

    const binary = await inspectTaskCode(runner, f.task, { operation: "file", path: "src/binary.bin" });
    assert.equal(binary.kind, "file");
    if (binary.kind === "file") assert.equal(binary.unavailable, "binary");

    fs.writeFileSync(path.join(f.dir, "src", "large.txt"), "x".repeat(MAX_CODE_FILE_BYTES + 1));
    const large = await inspectTaskCode(runner, f.task, { operation: "file", path: "src/large.txt" });
    assert.equal(large.kind, "file");
    if (large.kind === "file") assert.equal(large.unavailable, "tooLarge");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("task tree contains tracked and non-ignored untracked files", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.dir, "src", "new.ts"), "new\n");
    fs.writeFileSync(path.join(f.dir, "secret.env"), "hidden\n");
    const tree = await inspectTaskCode(runner, f.task, { operation: "tree" });
    assert.equal(tree.kind, "tree");
    if (tree.kind !== "tree") return;
    assert.ok(tree.files.includes("src/new.ts"));
    assert.ok(!tree.files.includes("secret.env"));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
