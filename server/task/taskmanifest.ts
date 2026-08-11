// Per-task manifest: <dataDir>/tasks/<id>/task.json on the machine the task runs
// on. THIS is the durable, edge-resident truth — co-located with the tmux session
// and worktree it describes, so a node can reconstruct its own catalog and adopt
// a wiped/empty DB from what's actually on its disk. Controllers never adopt a
// remote node's manifest.
//
// Like manifest.ts (repos.json) and tasks.ts, the file-shape functions are pure
// and the adopt helper takes a DB handle, so everything is testable against an
// in-memory sqlite + a temp dir without opening the real database.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import type { Task, TaskReference } from "../core/db.js";
import { getOwnedRepo, localHostId } from "../core/ownership.js";
import {
  kimiWorkspaceAgentContent,
  kimiWorkspaceAgentPath,
  listTaskReferences,
  pathIsInside,
  TASK_REFERENCE_MANIFEST,
} from "./references.js";

type DB = Database.Database;

// Bump ONLY for additive, backward-compatible changes (see the cross-version
// contract): an older node writes vN, a newer reader must still parse it.
export const TASK_MANIFEST_VERSION = 2;

export type TaskReferenceManifest = Omit<TaskReference, "created_at"> & {
  created_at?: string;
  repo_name?: string;
};

export interface TaskManifest {
  schema_version: number;
  task: Task;
  references?: TaskReferenceManifest[];
}

export interface TaskReferenceIndex {
  schema_version: 1;
  task_id: number;
  primary: {
    alias: "primary";
    repo_id: number;
    repo_name: string | null;
    path: ".";
    mode: "editable";
  };
  references: Array<{
    alias: string;
    repo_id: number;
    repo_name: string | null;
    requested_ref: string;
    resolved_commit: string;
    path: string;
    layout: "task-local" | "legacy-external";
    mode: "reference";
  }>;
}

export function taskManifest(task: Task, references: TaskReferenceManifest[] = []): TaskManifest {
  return { schema_version: TASK_MANIFEST_VERSION, task, references };
}

/** <dataDir>/tasks/<id>/task.json — the task's own folder on its machine. */
export function taskManifestPath(dataDir: string, id: number): string {
  return path.join(dataDir, "tasks", String(id), "task.json");
}

export function taskReferenceManifestPath(taskWorktree: string): string {
  return path.join(taskWorktree, TASK_REFERENCE_MANIFEST);
}

function slashPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function taskReferenceIndex(
  task: Task,
  references: TaskReferenceManifest[] = [],
  primaryName?: string,
): TaskReferenceIndex {
  return {
    schema_version: 1,
    task_id: task.id,
    primary: {
      alias: "primary",
      repo_id: task.repo_id,
      repo_name: primaryName ?? null,
      path: ".",
      mode: "editable",
    },
    references: references.map((reference) => {
      const local = pathIsInside(task.worktree_path, reference.worktree_path);
      return {
        alias: reference.alias,
        repo_id: reference.repo_id,
        repo_name: reference.repo_name ?? null,
        requested_ref: reference.requested_ref,
        resolved_commit: reference.resolved_commit,
        path: local
          ? slashPath(path.relative(task.worktree_path, reference.worktree_path)) || "."
          : reference.worktree_path,
        layout: local ? "task-local" : "legacy-external",
        mode: "reference",
      };
    }),
  };
}

function writeAtomic(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, contents);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function ensureTaskMetadataExcluded(taskWorktree: string): void {
  try {
    const reported = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: taskWorktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!reported) return;
    const excludePath = path.resolve(taskWorktree, reported);
    const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    if (current.split(/\r?\n/).includes(".tdsp/")) return;
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(excludePath, `${current && !current.endsWith("\n") ? "\n" : ""}.tdsp/\n`);
  } catch {
    // A retained directory can outlive its mirror metadata. The manifest is
    // still useful; inability to update a best-effort Git exclude is not fatal.
  }
}

function writeTaskWorkspaceFiles(
  task: Task,
  references: TaskReferenceManifest[],
  primaryName?: string,
): void {
  if (task.kind === "local" || !task.worktree_path) return;
  try {
    if (!fs.statSync(task.worktree_path).isDirectory()) return;
  } catch {
    return;
  }
  ensureTaskMetadataExcluded(task.worktree_path);
  writeAtomic(
    taskReferenceManifestPath(task.worktree_path),
    JSON.stringify(taskReferenceIndex(task, references, primaryName), null, 2) + "\n",
  );
  writeAtomic(kimiWorkspaceAgentPath(task.worktree_path), kimiWorkspaceAgentContent());
}

/** Write (or overwrite) a task's manifest — the single durable record of it. */
export function writeTaskManifest(
  dataDir: string,
  task: Task,
  references: TaskReferenceManifest[] = [],
  primaryName?: string,
): void {
  const p = taskManifestPath(dataDir, task.id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(taskManifest(task, references), null, 2));
  fs.writeFileSync(path.join(path.dirname(p), "workspace.json"), JSON.stringify({
    schema_version: 1,
    task_id: task.id,
    primary: task.kind === "local"
      ? { kind: "local", path: task.cwd }
      : {
          kind: "repository",
          repo_id: task.repo_id,
          repo_name: primaryName ?? null,
          branch: task.work_branch,
          base_commit: task.base_commit,
          path: task.worktree_path,
          mode: "editable",
        },
    references: references.map((reference) => ({
      alias: reference.alias,
      repo_id: reference.repo_id,
      repo_name: reference.repo_name ?? null,
      requested_ref: reference.requested_ref,
      resolved_commit: reference.resolved_commit,
      path: reference.worktree_path,
      mode: "reference",
    })),
  }, null, 2));
  writeTaskWorkspaceFiles(task, references, primaryName);
}

/** Re-project the DB's task row + normalized reference rows into the durable
 * manifest pair. Production mutations use this so a rename/resume never drops
 * reference metadata from disk. */
export function writeTaskManifestFromDb(dataDir: string, db: DB, id: number): void {
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task | undefined;
  if (!task) return;
  const references = listTaskReferences(db, id).map(({ mirror_path: _mirror, ...reference }) => reference);
  const repo = task.kind === "local"
    ? undefined
    : db.prepare("SELECT name FROM repos WHERE id=?").get(task.repo_id) as { name: string } | undefined;
  writeTaskManifest(dataDir, task, references, repo?.name);
}

/** Remove a task's manifest folder — call when the task record is deleted. */
export function removeTaskManifest(dataDir: string, id: number): void {
  fs.rmSync(path.dirname(taskManifestPath(dataDir, id)), { recursive: true, force: true });
}

/** Read every task manifest under <dataDir>/tasks — the ground truth on disk. */
export function readTaskManifests(dataDir: string): TaskManifest[] {
  const dir = path.join(dataDir, "tasks");
  let ids: string[];
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return []; // no tasks dir yet → nothing on disk
  }
  const out: TaskManifest[] = [];
  for (const id of ids) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, id, "task.json"), "utf8")) as TaskManifest);
    } catch {
      // a malformed/half-written manifest must not break the whole scan
    }
  }
  return out;
}

const TASK_COLS = [
  "id", "repo_id", "base_branch", "base_commit", "work_branch", "title", "prompt", "worktree_path",
  "session", "status", "error", "created_at", "kind", "host_id", "cwd",
  "claude_session", "provider_id", "agent", "agent_model",
] as const;

/**
 * Adopt manifests the DB doesn't already have — the "sit down at a node and see
 * the tasks living on it" path (incl. recovering a wiped DB from disk). NEVER
 * clobbers an existing row: the DB is authoritative for tasks it already owns;
 * adopt only fills in ones it's missing. Returns how many were inserted.
 */
export function adoptTaskManifests(db: DB, manifests: TaskManifest[]): number {
  const have = new Set((db.prepare("SELECT id FROM tasks").all() as { id: number }[]).map((r) => r.id));
  const ownerId = localHostId(db);
  const cols = TASK_COLS.join(", ");
  const placeholders = TASK_COLS.map(() => "?").join(", ");
  const insert = db.prepare(`INSERT INTO tasks (${cols}) VALUES (${placeholders})`);
  let adopted = 0;
  for (const m of manifests) {
    // Never rewrite the read manifest object while interpreting legacy defaults.
    const t = { ...(m.task as unknown as Record<string, unknown>) };
    if (typeof t?.id !== "number" || have.has(t.id)) continue;
    const kind = t.kind == null ? "repo" : String(t.kind);
    if (kind === "local") {
      // A legacy local manifest without host_id is still local; a manifest that
      // explicitly names another host is controller-owned remote residue and is
      // intentionally left on disk for the legacy auditor/migration tooling.
      if (ownerId == null || (t.host_id != null && Number(t.host_id) !== ownerId)) continue;
      if (t.host_id == null) t.host_id = ownerId;
    } else {
      // Repo manifests are adoptable only when the referenced repo is already in
      // this node's own catalog. A remote controller's repo row is never enough.
      const repoId = Number(t.repo_id);
      if (!Number.isInteger(repoId) || !getOwnedRepo(db, repoId)) continue;
    }
    insert.run(...TASK_COLS.map((c) => {
      if (c === "agent" && t[c] == null) return "claude";
      return (t[c] ?? null) as unknown;
    }));
    const insertReference = db.prepare(
      "INSERT OR IGNORE INTO task_references " +
        "(task_id,repo_id,alias,requested_ref,resolved_commit,worktree_path,mode,created_at) " +
        "VALUES (?,?,?,?,?,?,?,?)",
    );
    for (const reference of Array.isArray(m.references) ? m.references : []) {
      const repoId = Number(reference?.repo_id);
      if (!Number.isInteger(repoId) || !getOwnedRepo(db, repoId)) continue;
      const alias = String(reference?.alias ?? "").trim();
      const requestedRef = String(reference?.requested_ref ?? "").trim();
      const commit = String(reference?.resolved_commit ?? "").trim();
      const worktree = String(reference?.worktree_path ?? "").trim();
      if (!alias || !requestedRef || !commit || !worktree) continue;
      insertReference.run(
        t.id,
        repoId,
        alias,
        requestedRef,
        commit,
        worktree,
        "reference",
        reference.created_at ?? new Date().toISOString(),
      );
    }
    have.add(t.id);
    adopted++;
  }
  return adopted;
}
