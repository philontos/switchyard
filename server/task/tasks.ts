// Pure task-mutation helpers that take a DB handle (so they're testable against
// an in-memory sqlite, like schema.ts). The express routes in index.ts wrap
// these and map the result to an HTTP status.
import type Database from "better-sqlite3";
import { getOwnedTask } from "../core/ownership.js";

type DB = Database.Database;

export type RenameResult = { ok: true; title: string } | { error: "empty" | "notFound" };

/**
 * Rename a task's display title only. The tmux session name and git work_branch
 * are immutable identifiers tied to the running process / worktree, so they are
 * deliberately left untouched — renaming is a pure cosmetic DB update.
 */
export function renameTask(db: DB, id: number, rawTitle: unknown): RenameResult {
  const title = String(rawTitle ?? "").trim();
  if (!title) return { error: "empty" };
  if (!getOwnedTask(db, id)) return { error: "notFound" };
  db.prepare("UPDATE tasks SET title=? WHERE id=?").run(title, id);
  return { ok: true, title };
}
