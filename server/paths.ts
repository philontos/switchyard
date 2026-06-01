import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT = path.resolve(__dirname, "..");
export const WEB_DIR = path.join(ROOT, "web");

// Per-machine data root. The SAME layout lives on the local box (machine #0)
// and on every remote host, so "local" is just another machine. Holds
// mirrors/, worktrees/, repos.json, and (on the controller) dispatcher.db.
export const DATA_DIR = path.join(os.homedir(), ".task-dispatcher");
export const MIRRORS_DIR = path.join(DATA_DIR, "mirrors");
export const WORKTREES_DIR = path.join(DATA_DIR, "worktrees");
export const DB_PATH = path.join(DATA_DIR, "dispatcher.db");
export const MANIFEST_PATH = path.join(DATA_DIR, "repos.json");

// Dispatcher-owned CLAUDE_CONFIG_DIR — lets us install official plugins for the
// dispatcher WITHOUT touching the user's global ~/.claude. Its plugin cache
// (<this>/plugins/cache) is one of the skill scan roots; keep that subpath in
// sync with server/skills.ts defaultSources().
export const DISPATCHER_CLAUDE_CFG = path.join(DATA_DIR, "claude-config");

// One-time migration: relocate the legacy project-local ./data to the new
// home-dir root so existing repos/tasks/hosts survive the path change. Both
// live under $HOME (same filesystem), so a directory rename is atomic. The DB
// also stores absolute mirror/worktree paths under the old root — those get
// rewritten in db.ts once the DB is open, and worktree links repaired in
// migrate.ts (both keyed off DID_MIGRATE).
export const LEGACY_DATA_DIR = path.join(ROOT, "data");
export let DID_MIGRATE = false;
if (!fs.existsSync(DATA_DIR) && fs.existsSync(LEGACY_DATA_DIR)) {
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
  fs.renameSync(LEGACY_DATA_DIR, DATA_DIR);
  DID_MIGRATE = true;
}
