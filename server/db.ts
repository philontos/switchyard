import Database from "better-sqlite3";
import fs from "node:fs";
import { DATA_DIR, DB_PATH, LEGACY_DATA_DIR, DID_MIGRATE } from "./paths.js";
import { initSchema } from "./schema.js";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// create tables, reconcile columns onto older DBs, and run the one-time
// ./data -> ~/.task-dispatcher path rewrite only if we just moved the dir.
initSchema(db, { didMigrate: DID_MIGRATE, legacyDir: LEGACY_DATA_DIR, dataDir: DATA_DIR });

// Seed the local machine (kind='local', always present, machine #0) and make
// every repo belong to a machine — existing repos default to the local one.
{
  const local = db.prepare("SELECT id FROM hosts WHERE kind='local'").get() as { id: number } | undefined;
  let localId: number;
  if (local) {
    localId = local.id;
    db.prepare("UPDATE hosts SET data_dir=?, status='online' WHERE id=?").run(DATA_DIR, localId);
  } else {
    const info = db.prepare(
      "INSERT INTO hosts (name, target, kind, data_dir, status) VALUES ('local','','local',?,'online')"
    ).run(DATA_DIR);
    localId = Number(info.lastInsertRowid);
  }
  db.prepare("UPDATE repos SET host_id=? WHERE host_id IS NULL").run(localId);
}

export interface Repo {
  id: number;
  host_id: number;
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
  created_at: string;
  kind: string;              // 'repo' | 'local'
  host_id: number | null;    // local tasks: the machine they run on
  cwd: string | null;        // local tasks: working dir
}

export interface Host {
  id: number;
  name: string;
  target: string;
  kind: string;          // local | ssh | mosh
  session: string;
  data_dir: string | null;   // the machine's ~/.task-dispatcher
  status: string;            // online | offline | unknown
  last_checked: string | null;
  created_at: string;
}

export interface Preset {
  id: number;
  name: string;
  description: string | null;
  dispatch_prompt: string | null;
  skill_refs: string;        // JSON array string of "source:name"
  created_at: string;
}
