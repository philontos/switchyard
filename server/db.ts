import Database from "better-sqlite3";
import fs from "node:fs";
import { DATA_DIR, DB_PATH } from "./paths.js";

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
`);

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
