import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Repo, Task } from "../core/db.ts";
import type { ExecOpts, Runner } from "../fleet/runner.ts";
import {
  MAX_CODE_FILE_BYTES,
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
    default_branch: "main", project_path: null, mirror_path: dir,
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
