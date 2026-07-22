// Node-local task lifecycle operations. A bootstrapped node is the sole owner of
// its task rows, tmux sessions, worktrees and manifests, so remote controllers
// drive these functions through one-shot `tdsp` verbs instead of mutating their
// own databases.
import type Database from "better-sqlite3";
import type { Task } from "../core/db.js";
import { getOwnedRepo, getOwnedTask } from "../core/ownership.js";

type DB = Database.Database;

export type LifecycleResult =
  | { ok: true; alreadyAlive?: boolean }
  | {
      ok: false;
      error:
        | "notFound"
        | "notResumable"
        | "worktreeGone"
        | "worktreeExists"
        | "resumeFailed"
        | "cleanupFailed"
        | "deleteFailed";
      message?: string;
    };

interface ManifestEnv {
  db: DB;
  writeManifest(id: number): void | Promise<void>;
}

export interface ResumeTaskEnv extends ManifestEnv {
  exists(path: string): Promise<boolean>;
  hasSession(session: string): Promise<boolean>;
  startSession(task: Task): Promise<void>;
}

export interface CleanupTaskEnv extends ManifestEnv {
  killSession(session: string): Promise<void>;
  removeWorktree(mirror: string, worktree: string, workBranch: string): Promise<void>;
}

export interface DeleteTaskEnv {
  db: DB;
  exists(path: string): Promise<boolean>;
  removeManifest(id: number): void | Promise<void>;
}

function messageOf(error: unknown): string {
  return String((error as any)?.message || error);
}

/** Relaunch the task's original agent in its retained worktree. */
export async function resumeTask(env: ResumeTaskEnv, id: number): Promise<LifecycleResult> {
  const task = getOwnedTask(env.db, id);
  if (!task) return { ok: false, error: "notFound" };
  if (!task.session || !task.worktree_path) return { ok: false, error: "notResumable" };

  let hasWorktree = false;
  try {
    hasWorktree = await env.exists(task.worktree_path);
  } catch {
    // A failed filesystem probe cannot safely be treated as a resumable task.
  }
  if (!hasWorktree) return { ok: false, error: "worktreeGone" };

  try {
    const alreadyAlive = await env.hasSession(task.session).catch(() => false);
    if (!alreadyAlive) await env.startSession(task);
    env.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(id);
    await env.writeManifest(id);
    return { ok: true, alreadyAlive };
  } catch (error) {
    return { ok: false, error: "resumeFailed", message: messageOf(error) };
  }
}

/** End any remaining session and remove the retained repo worktree. */
export async function cleanupTask(env: CleanupTaskEnv, id: number): Promise<LifecycleResult> {
  const task = getOwnedTask(env.db, id);
  if (!task) return { ok: false, error: "notFound" };
  const repo = getOwnedRepo(env.db, task.repo_id);

  try {
    await env.killSession(task.session);
    if (repo?.mirror_path && task.worktree_path) {
      await env.removeWorktree(repo.mirror_path, task.worktree_path, task.work_branch);
    }
    env.db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(id);
    await env.writeManifest(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: "cleanupFailed", message: messageOf(error) };
  }
}

/** Delete only the durable record; retained worktrees must be cleaned first. */
export async function deleteTaskRecord(env: DeleteTaskEnv, id: number): Promise<LifecycleResult> {
  const task = getOwnedTask(env.db, id);
  if (!task) {
    // Idempotently remove a manifest only when the row is truly absent. If the
    // id belongs to a historical remote row, treating it as absent would let a
    // local command erase that row's controller-era manifest.
    if (env.db.prepare("SELECT id FROM tasks WHERE id=?").get(id)) {
      return { ok: false, error: "notFound" };
    }
    await env.removeManifest(id);
    return { ok: true };
  }

  try {
    if (task.worktree_path && (await env.exists(task.worktree_path))) {
      return { ok: false, error: "worktreeExists" };
    }
    env.db.prepare("DELETE FROM tasks WHERE id=?").run(id);
    await env.removeManifest(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: "deleteFailed", message: messageOf(error) };
  }
}
