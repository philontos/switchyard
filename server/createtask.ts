// Task-creation orchestration, extracted so BOTH the HTTP route and the `tdsp`
// CLI verb run the exact same code. In the edge-autonomy model a node only ever
// creates tasks ON ITSELF — so the orchestration is always local; the machine,
// shell-starter and cwd-check are injected (real localRunner in prod, fakes in
// tests). The durable record is the manifest, written here as the single writer.
import { writeTaskManifest } from "./taskmanifest.js";
import { resolveCwd } from "./local.js";
import type Database from "better-sqlite3";
import type { Task } from "./db.js";

type DB = Database.Database;

// tmux/branch-safe short id — same shape as index.ts's slug(). Kept local so the
// core doesn't drag in the HTTP server; fold into a shared util if a 3rd caller appears.
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
}

export interface LocalTaskEnv {
  db: DB;
  home: string; // the machine's home dir (os.homedir() in prod)
  ns: string; // this node's namespace (NS) — scopes the tmux session name
  dataDir: string; // this node's DATA_DIR — manifest root
  cwdExists(cwd: string): Promise<boolean>;
  startShell(session: string, cwd: string): Promise<void>;
}

export interface CreateLocalOpts {
  cwd?: string | null;
  title?: string | null;
}

export type CreateLocalResult =
  | { ok: true; id: number; session: string }
  | { ok: false; error: "cwdMissing" | "startFailed"; message?: string };

/**
 * Create a repo-less shell task on THIS machine: resolve+verify the cwd, insert
 * the row, start the tmux shell, flip to running, and write the manifest. On a
 * start failure the row is marked errored (and still manifested, so the node owns
 * the record of the failure). cwdMissing is rejected before any row is inserted.
 */
export async function createLocalTask(env: LocalTaskEnv, opts: CreateLocalOpts): Promise<CreateLocalResult> {
  const cwd = resolveCwd(opts.cwd, env.home);
  if (!(await env.cwdExists(cwd))) return { ok: false, error: "cwdMissing" };
  const provided = String(opts.title ?? "").trim();

  // a node's own local tasks belong to its local host row (so the UI groups them
  // under "this machine"); absent in a bare test DB → null, which reads as local.
  const localHost = env.db.prepare("SELECT id FROM hosts WHERE kind='local'").get() as { id: number } | undefined;
  const hostId = localHost?.id ?? null;

  // insert first so the row id seeds the auto-title and the session name
  const info = env.db
    .prepare(
      "INSERT INTO tasks (kind, host_id, repo_id, base_branch, work_branch, title, prompt, worktree_path, session, status, cwd) " +
        "VALUES ('local', ?, 0, '', '', ?, NULL, '', '', 'creating', ?)",
    )
    .run(hostId, provided, cwd);
  const id = Number(info.lastInsertRowid);
  const title = provided || `Local task #${id}`;
  const session = `tdsp-${env.ns}-${id}-local-${slug(title)}`;

  const manifest = () => writeTaskManifest(env.dataDir, env.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task);
  try {
    await env.startShell(session, cwd);
  } catch (e: any) {
    env.db.prepare("UPDATE tasks SET title=?, status='error', error=? WHERE id=?").run(title, String(e?.message || e), id);
    manifest();
    return { ok: false, error: "startFailed", message: String(e?.message || e) };
  }
  env.db.prepare("UPDATE tasks SET title=?, session=?, status='running' WHERE id=?").run(title, session, id);
  manifest();
  return { ok: true, id, session };
}
