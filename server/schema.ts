// Schema setup for the dispatcher DB: create tables, reconcile columns onto
// DBs created by older schemas (SQLite has no ADD COLUMN IF NOT EXISTS), and run
// the one-time ./data -> ~/.task-dispatcher path rewrite. Pulled out of db.ts so
// it can run against ANY sqlite handle (incl. an in-memory test DB) without
// opening the real database file.
import type Database from "better-sqlite3";

type DB = Database.Database;

export interface SchemaOpts { didMigrate: boolean; legacyDir: string; dataDir: string; }

const CREATE_SQL = `
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

-- preset task templates: a named bundle = an opening prompt template + a list
-- of skills to inject (referenced by "source:name"). Skills themselves are NOT
-- stored — they're scanned read-through (server/skills.ts) and copied into the
-- task worktree at dispatch.
CREATE TABLE IF NOT EXISTS presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  dispatch_prompt TEXT,
  skill_refs TEXT DEFAULT '[]',   -- JSON array of "source:name"
  created_at TEXT DEFAULT (datetime('now'))
);
`;

/** Add a column if it's missing — backfills schema drift on pre-existing DBs. */
function addColumn(db: DB, table: string, col: string, def: string) {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

/**
 * Reconcile the columns the code needs onto DBs created by older schemas. A
 * fresh DB already has them (from CREATE_SQL), so every call is a no-op there.
 *
 * mirror_path / worktree_path come FIRST: the path migration and the app's task
 * INSERTs reference them, and an old `tasks` table missing worktree_path is
 * exactly the "no such column: worktree_path" boot crash. Adding a NOT NULL
 * column to a table with rows requires a DEFAULT — '' is the "no worktree"
 * sentinel the app already treats as absent.
 */
function reconcileColumns(db: DB) {
  addColumn(db, "repos", "mirror_path", "TEXT");
  addColumn(db, "tasks", "worktree_path", "TEXT NOT NULL DEFAULT ''");
  // machine model (the hosts table doubles as "machines")
  addColumn(db, "hosts", "data_dir", "TEXT");                  // the machine's ~/.task-dispatcher
  addColumn(db, "hosts", "status", "TEXT DEFAULT 'unknown'");  // online | offline | unknown
  addColumn(db, "hosts", "last_checked", "TEXT");
  addColumn(db, "repos", "host_id", "INTEGER");                // which machine this repo lives on
  addColumn(db, "tasks", "preset_id", "INTEGER");              // preset this task was dispatched with
  addColumn(db, "tasks", "skills", "TEXT DEFAULT '[]'");       // JSON: source:name actually delivered
  // repo-less local quick tasks (kind='local'): no mirror/worktree, repo_id=0,
  // branch/worktree columns are "" — they carry their own host_id and cwd.
  addColumn(db, "tasks", "kind", "TEXT DEFAULT 'repo'");       // 'repo' | 'local'
  addColumn(db, "tasks", "host_id", "INTEGER");                // local tasks: which machine
  addColumn(db, "tasks", "cwd", "TEXT");                       // local tasks: working dir
}

/**
 * One-time ./data -> ~/.task-dispatcher path rewrite: stored absolute mirror/
 * worktree paths still point under the old root, so swap the prefix. Idempotent —
 * once rewritten no row matches the legacy prefix, so re-running is a no-op.
 */
export function runPathMigration(db: DB, legacyDir: string, dataDir: string) {
  db.prepare("UPDATE repos SET mirror_path = replace(mirror_path, ?, ?) WHERE mirror_path LIKE ? || '%'")
    .run(legacyDir, dataDir, legacyDir);
  db.prepare("UPDATE tasks SET worktree_path = replace(worktree_path, ?, ?) WHERE worktree_path LIKE ? || '%'")
    .run(legacyDir, dataDir, legacyDir);
}

/**
 * Create + reconcile the schema, then run the path migration ONLY when the data
 * dir was just physically moved (DID_MIGRATE) — not on every boot. The previous
 * guard (`LEGACY_DATA_DIR !== DATA_DIR`) was always true, so the migration ran
 * every startup and crashed any DB whose tasks table predated worktree_path.
 */
export function initSchema(db: DB, opts: SchemaOpts) {
  db.exec(CREATE_SQL);
  reconcileColumns(db);
  if (opts.didMigrate) runPathMigration(db, opts.legacyDir, opts.dataDir);
}
