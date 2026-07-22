import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT = path.resolve(__dirname, "..", "..");
export const WEB_DIR = path.join(ROOT, "web");

// Per-machine data root. The SAME layout lives on the local box (machine #0)
// and on every remote host, so "local" is just another machine. Holds
// mirrors/, worktrees/, repos.json, and this node's dispatcher.db.
//
// Defaults to ~/.task-dispatcher, but TASK_DISPATCHER_DATA_DIR overrides it so a
// second Switchyard instance on the same box — a dev/test instance, or a task
// that runs Switchyard itself — can point at an isolated data root instead
// of clobbering the live one's db/mirrors/worktrees (and, via the shared tmux
// server and its live sessions.
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = env.TASK_DISPATCHER_DATA_DIR;
  return override && override.trim() ? path.resolve(override) : path.join(home, ".task-dispatcher");
}
export const BASE_DATA_DIR = resolveDataDir();

// Per-instance namespace. Two Switchyard instances sharing one machine's disk +
// tmux server would otherwise collide because their DB ids both start at 1.
// The stable id scopes this node instance's data and session names. The legacy
// filename `controller-id` is retained to keep every existing DATA_DIR stable;
// its value is now interpreted as the local instance id, not remote ownership.
export function resolveNamespace(baseDir: string): string {
  const idFile = path.join(baseDir, "controller-id");
  try {
    const existing = fs.readFileSync(idFile, "utf8").trim();
    if (/^[a-z0-9]+$/.test(existing)) return existing;
  } catch { /* not created yet */ }
  const ns = crypto.randomBytes(4).toString("hex");
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(idFile, ns + "\n");
  } catch { /* best effort */ }
  return ns;
}
export const NS = resolveNamespace(BASE_DATA_DIR);
export const DATA_DIR = path.join(BASE_DATA_DIR, NS);
export const MIRRORS_DIR = path.join(DATA_DIR, "mirrors");
export const WORKTREES_DIR = path.join(DATA_DIR, "worktrees");
export const DB_PATH = path.join(DATA_DIR, "dispatcher.db");
export const MANIFEST_PATH = path.join(DATA_DIR, "repos.json");

// Dispatcher-owned CLAUDE_CONFIG_DIR — lets us install official plugins for the
// dispatcher WITHOUT touching the user's global ~/.claude. Its plugin cache
// (<this>/plugins/cache) is one of the skill scan roots; keep that subpath in
// sync with server/skills/skills.ts defaultSources().
export const DISPATCHER_CLAUDE_CFG = path.join(DATA_DIR, "claude-config");

// One-time migration: relocate the legacy project-local ./data to the new
// home-dir root so existing repos/tasks/hosts survive the path change. Both
// live under $HOME (same filesystem), so a directory rename is atomic. The DB
// also stores absolute mirror/worktree paths under the old root — those get
// rewritten in db.ts once the DB is open, and worktree links repaired in
// migrate.ts (both keyed off DID_MIGRATE).
export const LEGACY_DATA_DIR = path.join(ROOT, "data");
export let DID_MIGRATE = false;
if (!process.env.TASK_DISPATCHER_DATA_DIR && !fs.existsSync(DATA_DIR) && fs.existsSync(LEGACY_DATA_DIR)) {
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
  fs.renameSync(LEGACY_DATA_DIR, DATA_DIR);
  DID_MIGRATE = true;
}
