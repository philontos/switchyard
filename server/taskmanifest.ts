// Per-task manifest: <dataDir>/tasks/<id>/task.json on the machine the task runs
// on. THIS is the durable, edge-resident truth — co-located with the tmux session
// and worktree it describes, so a node owns its own tasks and any controller that
// reaches the machine (or the machine itself, sitting down later) can reconstruct
// the catalog and adopt a wiped/empty DB from what's actually on disk.
//
// Like manifest.ts (repos.json) and tasks.ts, the file-shape functions are pure
// and the adopt helper takes a DB handle, so everything is testable against an
// in-memory sqlite + a temp dir without opening the real database.
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Task } from "./db.js";

type DB = Database.Database;

// Bump ONLY for additive, backward-compatible changes (see the cross-version
// contract): an older node writes vN, a newer reader must still parse it.
export const TASK_MANIFEST_VERSION = 1;

export interface TaskManifest {
  schema_version: number;
  task: Task;
}

export function taskManifest(task: Task): TaskManifest {
  return { schema_version: TASK_MANIFEST_VERSION, task };
}

/** <dataDir>/tasks/<id>/task.json — the task's own folder on its machine. */
export function taskManifestPath(dataDir: string, id: number): string {
  return path.join(dataDir, "tasks", String(id), "task.json");
}

/** Write (or overwrite) a task's manifest — the single durable record of it. */
export function writeTaskManifest(dataDir: string, task: Task): void {
  const p = taskManifestPath(dataDir, task.id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(taskManifest(task), null, 2));
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
  "id", "repo_id", "base_branch", "work_branch", "title", "prompt", "worktree_path",
  "session", "status", "error", "created_at", "skills", "kind", "host_id", "cwd",
  "claude_session",
] as const;

/**
 * Adopt manifests the DB doesn't already have — the "sit down at a node and see
 * the tasks living on it" path (incl. recovering a wiped DB from disk). NEVER
 * clobbers an existing row: the DB is authoritative for tasks it already owns;
 * adopt only fills in ones it's missing. Returns how many were inserted.
 */
export function adoptTaskManifests(db: DB, manifests: TaskManifest[]): number {
  const have = new Set((db.prepare("SELECT id FROM tasks").all() as { id: number }[]).map((r) => r.id));
  const cols = TASK_COLS.join(", ");
  const placeholders = TASK_COLS.map(() => "?").join(", ");
  const insert = db.prepare(`INSERT INTO tasks (${cols}) VALUES (${placeholders})`);
  let adopted = 0;
  for (const m of manifests) {
    const t = m.task as unknown as Record<string, unknown>;
    if (typeof t?.id !== "number" || have.has(t.id)) continue;
    insert.run(...TASK_COLS.map((c) => (t[c] ?? null) as unknown));
    have.add(t.id);
    adopted++;
  }
  return adopted;
}
