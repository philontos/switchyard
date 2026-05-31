import Database from "better-sqlite3";
import fs from "node:fs";
import { DATA_DIR, DB_PATH, LEGACY_DATA_DIR } from "./paths.js";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  git_url TEXT NOT NULL,
  token TEXT,
  default_branch TEXT DEFAULT 'main',
  project_path TEXT,           -- gitlab project path for glab, e.g. group/repo
  mirror_path TEXT,
  status TEXT DEFAULT 'cloning', -- cloning | ready | error
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  base_branch TEXT NOT NULL,
  work_branch TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT,
  worktree_path TEXT NOT NULL,
  session TEXT NOT NULL,
  status TEXT DEFAULT 'running', -- running | done | error | cleaned
  error TEXT,
  mr_url TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- remote machines reachable over ssh/mosh; a pure terminal entry (L1),
-- no git/worktree involved — everything runs ON the remote host.
CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target TEXT NOT NULL,           -- ssh target, e.g. user@host
  kind TEXT DEFAULT 'ssh',        -- ssh | mosh
  session TEXT DEFAULT 'main',    -- remote tmux session to attach/create
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// One-time path migration (pairs with the ./data -> ~/.task-dispatcher move in
// paths.ts): the DB stores absolute mirror/worktree paths under the old root,
// so rewrite that prefix to the new DATA_DIR. Idempotent — once rewritten no
// row matches the legacy prefix, so re-running is a no-op.
if (LEGACY_DATA_DIR !== DATA_DIR) {
  db.prepare(
    "UPDATE repos SET mirror_path = replace(mirror_path, ?, ?) WHERE mirror_path LIKE ? || '%'"
  ).run(LEGACY_DATA_DIR, DATA_DIR, LEGACY_DATA_DIR);
  db.prepare(
    "UPDATE tasks SET worktree_path = replace(worktree_path, ?, ?) WHERE worktree_path LIKE ? || '%'"
  ).run(LEGACY_DATA_DIR, DATA_DIR, LEGACY_DATA_DIR);
}

export interface Repo {
  id: number;
  name: string;
  git_url: string;
  token: string | null;
  default_branch: string;
  project_path: string | null;
  mirror_path: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

export interface Task {
  id: number;
  repo_id: number;
  base_branch: string;
  work_branch: string;
  title: string;
  prompt: string | null;
  worktree_path: string;
  session: string;
  status: string;
  error: string | null;
  mr_url: string | null;
  created_at: string;
}

export interface Host {
  id: number;
  name: string;
  target: string;
  kind: string;
  session: string;
  created_at: string;
}
