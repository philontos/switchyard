import type Database from "better-sqlite3";
import path from "node:path";
import type { Repo, Task, TaskReference } from "../core/db.js";
import { getOwnedRepo } from "../core/ownership.js";

type DB = Database.Database;

export interface TaskReferenceInput {
  repo_id: number;
  ref?: string | null;
  branch?: string | null;
  alias?: string | null;
}

export interface ResolvedReferenceInput {
  repo: Repo & { mirror_path: string };
  alias: string;
  requested_ref: string;
}

export interface TaskReferenceRecord extends TaskReference {
  repo_name: string;
  mirror_path: string | null;
}

export const TASK_REFERENCE_MANIFEST = ".tdsp/refs.json";
export const TASK_REFERENCE_ROOT = ".tdsp/refs";
export const KIMI_WORKSPACE_AGENT = ".tdsp/kimi-agent.md";

/** Stable launch-time contract. The paths and commits deliberately do not live
 * here: refs.json is rewritten atomically whenever a Ref is attached, so a
 * long-running agent can discover new repositories without being restarted. */
export const TASK_WORKSPACE_INSTRUCTIONS = [
  "Switchyard manages this task workspace.",
  "The primary repository in the current working directory is editable.",
  `Repository references may change while the session is running; their authoritative alias map is ${TASK_REFERENCE_MANIFEST}.`,
  "Read that manifest once at session start; whenever the user later mentions a Ref, repository, or alias, reread it and resolve by exact alias first, then repo_name, before inspecting files.",
  "Use the path recorded in the manifest and treat entries whose mode is reference as read-only unless the user explicitly asks to modify or promote one.",
  "Reference paths are generated Git-ignored metadata, so inspect or search them by explicit path instead of relying on workspace-wide indexes.",
  "Before relying on a referenced repository, follow any repository-local agent instructions inside it.",
].join(" ");

export type ResolveReferencesResult =
  | { ok: true; references: ResolvedReferenceInput[] }
  | { ok: false; error: string };

function aliasSlug(value: string, repoId: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 32);
  return slug || `repo-${repoId}`;
}

function uniqueAlias(seed: string, used: Set<string>): string {
  if (!used.has(seed)) {
    used.add(seed);
    return seed;
  }
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = seed.slice(0, 32 - suffix.length) + suffix;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error("could not create a unique repository reference alias");
}

// Equivalent to the safety-relevant `git check-ref-format --branch` rules. The
// selected value is a branch name (not an arbitrary revision expression) and is
// later interpolated into a fetch refspec, so reject ref metacharacters here.
function isBranchName(value: string): boolean {
  if (!value || value.length > 255 || value === "@" || value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  if (value.includes("..") || value.includes("@{") || value.includes("//") || value.endsWith(".")) return false;
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(value)) return false;
  return !value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"));
}

/** Resolve client-supplied repo ids against this node's own catalog. Paths and
 * mirror coordinates are never accepted from the client. */
export function resolveReferenceInputs(
  db: DB,
  raw: unknown,
  aliasesInUse: Iterable<string> = [],
): ResolveReferencesResult {
  if (raw == null) return { ok: true, references: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "references must be an array" };
  if (raw.length > 8) return { ok: false, error: "a task can reference at most 8 repositories" };

  const used = new Set([...aliasesInUse].map((alias) => aliasSlug(String(alias), 0)));
  const references: ResolvedReferenceInput[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") return { ok: false, error: "invalid repository reference" };
    const input = value as TaskReferenceInput;
    const repoId = Number(input.repo_id);
    if (!Number.isInteger(repoId) || repoId <= 0) return { ok: false, error: "invalid reference repository" };
    const repo = getOwnedRepo(db, repoId);
    if (!repo?.mirror_path) return { ok: false, error: `reference repository ${repoId} was not found on this node` };
    if (repo.status !== "ready") return { ok: false, error: `reference repository ${repo.name} is ${repo.status}` };

    const requestedRef = String(input.ref ?? input.branch ?? repo.default_branch ?? "").trim();
    if (!isBranchName(requestedRef)) {
      return { ok: false, error: `invalid reference branch for ${repo.name}` };
    }
    const seed = aliasSlug(String(input.alias || repo.name), repo.id);
    references.push({
      repo: repo as Repo & { mirror_path: string },
      alias: uniqueAlias(seed, used),
      requested_ref: requestedRef,
    });
  }
  return { ok: true, references };
}

export function listTaskReferences(db: DB, taskId: number): TaskReferenceRecord[] {
  return db.prepare(
    "SELECT tr.*, r.name AS repo_name, r.mirror_path AS mirror_path " +
      "FROM task_references tr LEFT JOIN repos r ON r.id=tr.repo_id " +
      "WHERE tr.task_id=? ORDER BY tr.alias",
  ).all(taskId) as TaskReferenceRecord[];
}

export function referenceWorktreePaths(db: DB, taskId: number): string[] {
  return listTaskReferences(db, taskId).map((reference) => reference.worktree_path).filter(Boolean);
}

/** New task-local Ref root. Because it is below the primary workspace, agents
 * can see newly attached snapshots without a runtime --add-dir or TUI reload. */
export function referenceRootPath(taskWorktree: string): string {
  return path.join(taskWorktree, TASK_REFERENCE_ROOT);
}

/** Pre-manifest layout retained for discovery and cleanup of existing tasks. */
export function legacyReferenceRootPath(dataDir: string, taskId: number): string {
  return path.join(dataDir, "worktrees", "refs", String(taskId));
}

export function referenceRootPaths(dataDir: string, taskId: number, taskWorktree?: string | null): string[] {
  return [
    ...(taskWorktree ? [referenceRootPath(taskWorktree)] : []),
    legacyReferenceRootPath(dataDir, taskId),
  ];
}

export function kimiWorkspaceAgentPath(taskWorktree: string): string {
  return path.join(taskWorktree, KIMI_WORKSPACE_AGENT);
}

export function kimiWorkspaceAgentContent(): string {
  return [
    "---",
    "name: switchyard-task",
    "description: Switchyard coding task with dynamic repository references",
    "---",
    "",
    "${base_prompt}",
    "",
    TASK_WORKSPACE_INSTRUCTIONS,
    "",
  ].join("\n");
}

export function pathIsInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Only legacy Refs sit outside the primary workspace and still need --add-dir
 * when an old task is resumed. New task-local snapshots need no adapter work. */
export function externalReferenceWorktreePaths(
  db: DB,
  task: Pick<Task, "id" | "worktree_path">,
): string[] {
  return referenceWorktreePaths(db, task.id).filter((referencePath) =>
    !task.worktree_path || !pathIsInside(task.worktree_path, referencePath),
  );
}

export function removeTaskReferenceRows(db: DB, taskId: number): void {
  db.prepare("DELETE FROM task_references WHERE task_id=?").run(taskId);
}

export function publicTaskReferences(db: DB, taskId: number) {
  return listTaskReferences(db, taskId).map(({ mirror_path: _mirror, worktree_path: _path, ...reference }) => reference);
}
