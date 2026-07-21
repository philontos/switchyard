// Read-only repository/worktree inspection. Git remains the source of truth:
// repository views read an immutable commit from the bare mirror; task views
// read the live worktree and compare it with the commit captured at dispatch.
// No caller supplies a filesystem root — only a repo/task id plus a validated
// Git-visible relative path can reach this module.
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Repo, Task } from "../core/db.js";
import type { Runner } from "../fleet/runner.js";
import { fetchBranch } from "../repo/git.js";

type DB = Database.Database;

export const CODE_VIEW_CAPABILITY = "code-view-v1";
export const MAX_CODE_FILE_BYTES = 1024 * 1024;
export const MAX_CODE_DIFF_BYTES = 2 * 1024 * 1024;
export const MAX_CODE_TREE_BYTES = 5 * 1024 * 1024;
export const MAX_CODE_TREE_FILES = 50000;

export type CodeScope = "repo" | "task";
export type CodeOperation = "tree" | "file" | "changes" | "diff";

export interface CodeInspectRequest {
  scope: CodeScope;
  id: number;
  operation: CodeOperation;
  path?: string;
  refresh?: boolean;
}

export interface CodeRevision {
  label: string;
  commit: string;
  approximate?: boolean;
}

export interface CodeTreePayload {
  kind: "tree";
  files: string[];
  truncated: boolean;
  revision: CodeRevision;
  generatedAt: string;
}

export type FileUnavailableReason = "binary" | "tooLarge" | "symlink" | "submodule";

export interface CodeFilePayload {
  kind: "file";
  path: string;
  size: number;
  content: string | null;
  unavailable?: FileUnavailableReason;
  revision: CodeRevision;
  generatedAt: string;
}

export interface CodeChange {
  path: string;
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | "?";
  oldPath?: string;
}

export interface CodeChangesPayload {
  kind: "changes";
  files: CodeChange[];
  revision: CodeRevision;
  head: string;
  generatedAt: string;
}

export interface CodeDiffPayload {
  kind: "diff";
  path: string;
  content: string | null;
  truncated: boolean;
  binary: boolean;
  revision: CodeRevision;
  generatedAt: string;
}

export type CodePayload = CodeTreePayload | CodeFilePayload | CodeChangesPayload | CodeDiffPayload;
export type CodeInspectResult =
  | ({ ok: true } & CodePayload)
  | { ok: false; error: string; message: string };

export class CodeViewError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "CodeViewError";
  }
}

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=15",
};

function codePath(value: unknown): string {
  const raw = String(value ?? "");
  // Backslashes are valid Git filename bytes on POSIX, but are path separators
  // on Windows. Reject them in this deliberately small cross-platform contract
  // rather than letting the same request mean different paths on each node.
  if (!raw || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) {
    throw new CodeViewError("invalidPath", "Invalid file path");
  }
  const parts = raw.split("/");
  if (parts.some((p) => !p || p === "." || p === "..") || parts[0] === ".git") {
    throw new CodeViewError("invalidPath", "Invalid file path");
  }
  return raw;
}

function literalPathspec(value: string): string {
  return `:(top,literal)${value}`;
}

async function git(runner: Runner, cwd: string, args: string[], maxBuffer?: number): Promise<string> {
  return runner.exec("git", args, { cwd, env: GIT_ENV, maxBuffer });
}

function errorStdout(error: any): string {
  if (typeof error?.stdout === "string") return error.stdout;
  if (Buffer.isBuffer(error?.stdout)) return error.stdout.toString("utf8");
  return "";
}

function isMaxBufferError(error: any): boolean {
  return error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer|stdout maxBuffer/i.test(String(error?.message || ""));
}

async function gitCapped(
  runner: Runner,
  cwd: string,
  args: string[],
  maxBuffer: number,
): Promise<{ text: string; truncated: boolean }> {
  try {
    return { text: await git(runner, cwd, args, maxBuffer), truncated: false };
  } catch (error: any) {
    if (isMaxBufferError(error)) return { text: errorStdout(error).slice(0, maxBuffer), truncated: true };
    throw error;
  }
}

function zFields(text: string, truncated = false): string[] {
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  else if (truncated) fields.pop(); // discard a path cut in half by maxBuffer
  return fields;
}

function treeFiles(text: string, truncated: boolean): { files: string[]; truncated: boolean } {
  const all = zFields(text, truncated).filter((p) => p && !p.startsWith(".git/"));
  if (all.length > MAX_CODE_TREE_FILES) return { files: all.slice(0, MAX_CODE_TREE_FILES), truncated: true };
  return { files: all, truncated };
}

async function revParse(runner: Runner, cwd: string, ref: string): Promise<string | null> {
  try {
    return (await git(runner, cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
}

async function repoRevision(runner: Runner, repo: Repo, refresh: boolean): Promise<CodeRevision> {
  if (!repo.mirror_path) throw new CodeViewError("notReady", "Repository mirror is not ready");
  const tracking = `refs/remotes/origin/${repo.default_branch}`;
  if (refresh) await fetchBranch(runner, repo.mirror_path, repo.default_branch);
  let commit = await revParse(runner, repo.mirror_path, tracking);
  if (!commit) {
    commit = await revParse(runner, repo.mirror_path, `refs/heads/${repo.default_branch}`);
  }
  if (!commit) {
    await fetchBranch(runner, repo.mirror_path, repo.default_branch);
    commit = await revParse(runner, repo.mirror_path, tracking);
  }
  if (!commit) throw new CodeViewError("refMissing", `Branch ${repo.default_branch} is not available`);
  return { label: repo.default_branch, commit };
}

async function taskHead(runner: Runner, task: Task): Promise<string> {
  if (!task.worktree_path || !(await runner.exists(task.worktree_path).catch(() => false))) {
    throw new CodeViewError("worktreeGone", "Task worktree is no longer available");
  }
  const head = await revParse(runner, task.worktree_path, "HEAD");
  if (!head) throw new CodeViewError("notRepository", "Task worktree is not a Git repository");
  return head;
}

async function commitExists(runner: Runner, worktree: string, commit: string): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) return false;
  try {
    await git(runner, worktree, ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function taskBaseRevision(runner: Runner, task: Task): Promise<CodeRevision> {
  const head = await taskHead(runner, task);
  if (task.base_commit && (await commitExists(runner, task.worktree_path, task.base_commit))) {
    return { label: task.base_branch, commit: task.base_commit };
  }

  // Older rows predate base_commit. Prefer merge-base with the recorded base;
  // if that ref disappeared, the work-branch reflog's oldest entry is the commit
  // at which `git worktree add -b` created it. Both are explicitly marked as an
  // approximation so callers never mistake a reconstructed baseline for exact.
  const refs = [
    `refs/remotes/origin/${task.base_branch}`,
    `refs/heads/${task.base_branch}`,
  ];
  for (const ref of refs) {
    try {
      const commit = (await git(runner, task.worktree_path, ["merge-base", "HEAD", ref])).trim();
      if (commit) return { label: task.base_branch, commit, approximate: true };
    } catch { /* try the next recovery path */ }
  }
  if (task.work_branch) {
    try {
      const reflog = await git(runner, task.worktree_path, [
        "reflog", "show", "--format=%H", "--reverse", `refs/heads/${task.work_branch}`,
      ]);
      const commit = reflog.trim().split("\n").find(Boolean);
      if (commit && (await commitExists(runner, task.worktree_path, commit))) {
        return { label: task.base_branch, commit, approximate: true };
      }
    } catch { /* fall through */ }
  }
  return { label: task.base_branch, commit: head, approximate: true };
}

function generatedAt(): string {
  return new Date().toISOString();
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controls++;
  }
  return sample.length > 0 && controls / sample.length > 0.1;
}

function textFromBuffer(buffer: Buffer): string | null {
  if (looksBinary(buffer)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

interface RawFileRead {
  size: number;
  buffer?: Buffer;
  unavailable?: "tooLarge" | "symlink";
}

function pathInside(base: string, target: string): boolean {
  return target === base || target.startsWith(base + path.sep);
}

function readLocalFile(base: string, rel: string): RawFileRead {
  let realBase: string;
  try { realBase = fs.realpathSync(base); }
  catch { throw new CodeViewError("worktreeGone", "Task worktree is no longer available"); }
  const target = path.resolve(realBase, ...rel.split("/"));
  if (!pathInside(realBase, target)) throw new CodeViewError("invalidPath", "Invalid file path");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); }
  catch { throw new CodeViewError("fileMissing", "File is no longer available"); }
  if (stat.isSymbolicLink()) return { size: stat.size, unavailable: "symlink" };
  if (!stat.isFile()) throw new CodeViewError("fileMissing", "Path is not a regular file");
  const realTarget = fs.realpathSync(target);
  if (!pathInside(realBase, realTarget)) throw new CodeViewError("invalidPath", "File resolves outside the worktree");
  if (stat.size > MAX_CODE_FILE_BYTES) return { size: stat.size, unavailable: "tooLarge" };
  return { size: stat.size, buffer: fs.readFileSync(realTarget) };
}

const REMOTE_READ_SCRIPT = String.raw`
const fs = require("node:fs"), path = require("node:path");
const base = process.argv[1], rel = process.argv[2], max = Number(process.argv[3]);
const send = (v) => process.stdout.write(JSON.stringify(v));
(() => {
  try {
    const rb = fs.realpathSync(base), target = path.resolve(rb, ...rel.split("/"));
    if (!(target === rb || target.startsWith(rb + path.sep))) return send({ ok:false, reason:"invalidPath" });
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return send({ ok:true, size:st.size, reason:"symlink" });
    if (!st.isFile()) return send({ ok:false, reason:"fileMissing" });
    const rt = fs.realpathSync(target);
    if (!(rt === rb || rt.startsWith(rb + path.sep))) return send({ ok:false, reason:"invalidPath" });
    if (st.size > max) return send({ ok:true, size:st.size, reason:"tooLarge" });
    send({ ok:true, size:st.size, data:fs.readFileSync(rt).toString("base64") });
  } catch (_) { send({ ok:false, reason:"fileMissing" }); }
})();
`;

async function readWorktreeFile(runner: Runner, base: string, rel: string): Promise<RawFileRead> {
  if (runner.kind === "local") return readLocalFile(base, rel);
  const raw = await runner.exec("node", ["-e", REMOTE_READ_SCRIPT, base, rel, String(MAX_CODE_FILE_BYTES)], {
    maxBuffer: Math.ceil(MAX_CODE_FILE_BYTES * 1.5) + 4096,
  });
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { throw new CodeViewError("readFailed", "Could not read file from the task machine"); }
  if (!parsed?.ok) throw new CodeViewError(parsed?.reason || "fileMissing", "File is no longer available");
  if (parsed.reason === "tooLarge" || parsed.reason === "symlink") {
    return { size: Number(parsed.size) || 0, unavailable: parsed.reason };
  }
  return { size: Number(parsed.size) || 0, buffer: Buffer.from(String(parsed.data || ""), "base64") };
}

async function assertTaskVisiblePath(runner: Runner, task: Task, rel: string): Promise<void> {
  const out = await git(runner, task.worktree_path, [
    "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", literalPathspec(rel),
  ]);
  if (!zFields(out).includes(rel)) throw new CodeViewError("fileMissing", "File is not part of the visible worktree");
}

export async function inspectRepoCode(
  runner: Runner,
  repo: Repo,
  request: Pick<CodeInspectRequest, "operation" | "path" | "refresh">,
): Promise<CodePayload> {
  const revision = await repoRevision(runner, repo, !!request.refresh);
  const mirror = repo.mirror_path as string;
  if (request.operation === "tree") {
    const out = await gitCapped(runner, mirror, ["ls-tree", "-r", "-z", "--name-only", revision.commit], MAX_CODE_TREE_BYTES);
    const tree = treeFiles(out.text, out.truncated);
    return { kind: "tree", ...tree, revision, generatedAt: generatedAt() };
  }
  if (request.operation !== "file") throw new CodeViewError("invalidOperation", "Repository views only support tree and file operations");

  const rel = codePath(request.path);
  const entry = await git(runner, mirror, ["ls-tree", "-z", revision.commit, "--", literalPathspec(rel)]);
  const header = zFields(entry)[0]?.split("\t", 1)[0] || "";
  const mode = header.split(" ")[0];
  if (!mode) throw new CodeViewError("fileMissing", "File is not present in this revision");
  if (mode === "120000") {
    return { kind: "file", path: rel, size: 0, content: null, unavailable: "symlink", revision, generatedAt: generatedAt() };
  }
  if (mode === "160000") {
    return { kind: "file", path: rel, size: 0, content: null, unavailable: "submodule", revision, generatedAt: generatedAt() };
  }
  const spec = `${revision.commit}:${rel}`;
  const size = Number((await git(runner, mirror, ["cat-file", "-s", spec])).trim());
  if (!Number.isFinite(size)) throw new CodeViewError("fileMissing", "File is not present in this revision");
  if (size > MAX_CODE_FILE_BYTES) {
    return { kind: "file", path: rel, size, content: null, unavailable: "tooLarge", revision, generatedAt: generatedAt() };
  }
  const raw = await git(runner, mirror, ["cat-file", "blob", spec], MAX_CODE_FILE_BYTES + 4096);
  const buffer = Buffer.from(raw, "utf8");
  // Runner stdout is UTF-8 text. If Git emitted invalid UTF-8, Node has already
  // inserted replacement characters; byte-size parity keeps those corrupted
  // blobs from ever being presented as source text.
  const decodedCleanly = !raw.includes("\uFFFD") && Buffer.byteLength(raw, "utf8") === size;
  const content = decodedCleanly ? textFromBuffer(buffer) : null;
  return {
    kind: "file", path: rel, size, content,
    ...(content == null ? { unavailable: "binary" as const } : {}),
    revision, generatedAt: generatedAt(),
  };
}

function parseNameStatus(text: string): CodeChange[] {
  const fields = zFields(text);
  const changes: CodeChange[] = [];
  for (let i = 0; i < fields.length;) {
    const rawStatus = fields[i++] || "M";
    const status = rawStatus[0] as CodeChange["status"];
    if (status === "R" || status === "C") {
      const oldPath = fields[i++];
      const nextPath = fields[i++];
      if (oldPath && nextPath) changes.push({ path: nextPath, oldPath, status });
    } else {
      const nextPath = fields[i++];
      if (nextPath) changes.push({ path: nextPath, status: ["A", "M", "D", "T", "U"].includes(status) ? status : "M" });
    }
  }
  return changes;
}

async function taskChanges(runner: Runner, task: Task): Promise<CodeChangesPayload> {
  const head = await taskHead(runner, task);
  const revision = await taskBaseRevision(runner, task);
  const tracked = await git(runner, task.worktree_path, [
    "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--name-status", "-z", revision.commit, "--",
  ]);
  const files = parseNameStatus(tracked);
  const seen = new Set(files.map((f) => f.path));
  const untracked = await git(runner, task.worktree_path, ["ls-files", "-z", "--others", "--exclude-standard"]);
  for (const rel of zFields(untracked)) {
    if (rel && !seen.has(rel)) files.push({ path: rel, status: "?" });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { kind: "changes", files, revision, head, generatedAt: generatedAt() };
}

function untrackedPatch(rel: string, content: string): string {
  const lines = content.split("\n");
  const hasFinalNewline = content.endsWith("\n");
  if (hasFinalNewline) lines.pop();
  const quoted = JSON.stringify(rel);
  let patch = `diff --git a/${quoted} b/${quoted}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`;
  if (lines.length) patch += `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
  if (lines.length && !hasFinalNewline) patch += "\\ No newline at end of file\n";
  return patch;
}

async function taskDiff(runner: Runner, task: Task, requestedPath: unknown): Promise<CodeDiffPayload> {
  const rel = codePath(requestedPath);
  const changes = await taskChanges(runner, task);
  const change = changes.files.find((f) => f.path === rel || f.oldPath === rel);
  if (!change) throw new CodeViewError("fileUnchanged", "File has no changes relative to the task baseline");

  if (change.status === "?") {
    await assertTaskVisiblePath(runner, task, rel);
    const read = await readWorktreeFile(runner, task.worktree_path, rel);
    if (read.unavailable || !read.buffer) {
      return {
        kind: "diff", path: rel, content: null, truncated: read.unavailable === "tooLarge",
        binary: read.unavailable !== "tooLarge", revision: changes.revision, generatedAt: generatedAt(),
      };
    }
    const content = textFromBuffer(read.buffer);
    if (content == null) {
      return { kind: "diff", path: rel, content: null, truncated: false, binary: true, revision: changes.revision, generatedAt: generatedAt() };
    }
    const patch = untrackedPatch(rel, content);
    return {
      kind: "diff", path: rel, content: patch.slice(0, MAX_CODE_DIFF_BYTES),
      truncated: patch.length > MAX_CODE_DIFF_BYTES, binary: false,
      revision: changes.revision, generatedAt: generatedAt(),
    };
  }

  const paths = [change.oldPath, change.path].filter((p): p is string => !!p).map(literalPathspec);
  const out = await gitCapped(runner, task.worktree_path, [
    "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--unified=3",
    changes.revision.commit, "--", ...paths,
  ], MAX_CODE_DIFF_BYTES);
  const binary = /(?:Binary files .* differ|GIT binary patch)/.test(out.text);
  return {
    kind: "diff", path: change.path, content: binary ? null : out.text,
    truncated: out.truncated, binary, revision: changes.revision, generatedAt: generatedAt(),
  };
}

export async function inspectTaskCode(
  runner: Runner,
  task: Task,
  request: Pick<CodeInspectRequest, "operation" | "path">,
): Promise<CodePayload> {
  if (task.kind === "local" || !task.repo_id) throw new CodeViewError("notRepoTask", "Shell tasks do not have a repository worktree");
  const head = await taskHead(runner, task);
  if (request.operation === "tree") {
    const out = await gitCapped(runner, task.worktree_path, [
      "ls-files", "-z", "--cached", "--others", "--exclude-standard",
    ], MAX_CODE_TREE_BYTES);
    const tree = treeFiles(out.text, out.truncated);
    return {
      kind: "tree", ...tree,
      revision: { label: task.work_branch || task.base_branch, commit: head },
      generatedAt: generatedAt(),
    };
  }
  if (request.operation === "changes") return taskChanges(runner, task);
  if (request.operation === "diff") return taskDiff(runner, task, request.path);
  if (request.operation !== "file") throw new CodeViewError("invalidOperation", "Unsupported code operation");

  const rel = codePath(request.path);
  await assertTaskVisiblePath(runner, task, rel);
  const read = await readWorktreeFile(runner, task.worktree_path, rel);
  if (read.unavailable) {
    return {
      kind: "file", path: rel, size: read.size, content: null, unavailable: read.unavailable,
      revision: { label: task.work_branch || task.base_branch, commit: head }, generatedAt: generatedAt(),
    };
  }
  const content = read.buffer ? textFromBuffer(read.buffer) : null;
  return {
    kind: "file", path: rel, size: read.size, content,
    ...(content == null ? { unavailable: "binary" as const } : {}),
    revision: { label: task.work_branch || task.base_branch, commit: head }, generatedAt: generatedAt(),
  };
}

export function isCodeInspectRequest(value: unknown): value is CodeInspectRequest {
  const v = value as any;
  return !!v && (v.scope === "repo" || v.scope === "task")
    && Number.isInteger(v.id) && v.id > 0
    && ["tree", "file", "changes", "diff"].includes(v.operation)
    && (v.path == null || typeof v.path === "string")
    && (v.refresh == null || typeof v.refresh === "boolean");
}

export async function codeResult(work: () => Promise<CodePayload>): Promise<CodeInspectResult> {
  try {
    return { ok: true, ...(await work()) };
  } catch (error: any) {
    const code = error instanceof CodeViewError ? error.code : "inspectFailed";
    return { ok: false, error: code, message: String(error?.message || error) };
  }
}

/** Resolve an owner-local request by id. Used by the one-shot tdsp verb. */
export async function inspectOwnedCode(db: DB, runner: Runner, request: CodeInspectRequest): Promise<CodeInspectResult> {
  if (!isCodeInspectRequest(request)) return { ok: false, error: "invalidRequest", message: "Invalid code inspection request" };
  if (request.scope === "repo") {
    const repo = db.prepare("SELECT * FROM repos WHERE id=?").get(request.id) as Repo | undefined;
    if (!repo) return { ok: false, error: "notFound", message: "Repository not found" };
    return codeResult(() => inspectRepoCode(runner, repo, request));
  }
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(request.id) as Task | undefined;
  if (!task) return { ok: false, error: "notFound", message: "Task not found" };
  return codeResult(() => inspectTaskCode(runner, task, request));
}

export function codeErrorStatus(code: string): number {
  if (["notFound", "fileMissing"].includes(code)) return 404;
  if (["worktreeGone", "notReady", "refMissing", "fileUnchanged", "notRepoTask"].includes(code)) return 409;
  if (["invalidRequest", "invalidPath", "invalidOperation"].includes(code)) return 400;
  return 500;
}
