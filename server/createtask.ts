// Task-creation orchestration, extracted so BOTH the HTTP route and the `tdsp`
// CLI verb run the exact same code. In the edge-autonomy model a node only ever
// creates tasks ON ITSELF — so the orchestration is always local; the machine,
// shell-starter and cwd-check are injected (real localRunner in prod, fakes in
// tests). The durable record is the manifest, written here as the single writer.
import path from "node:path";
import { writeTaskManifest } from "./taskmanifest.js";
import { resolveCwd } from "./local.js";
import { skillsLine } from "./skills.js";
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

// ---------- stop ----------
export interface StopTaskEnv {
  db: DB;
  killSession(session: string): Promise<void>;
  writeManifest(id: number): void | Promise<void>;
}

export type StopResult = { ok: true } | { ok: false; error: "notFound" };

/**
 * Stop one of THIS node's tasks: kill its tmux session, mark it cleaned, and
 * re-write the manifest so the durable record reflects the stop. The owning node
 * runs this (directly, or driven by `ssh <node> tdsp stop <id>`). The worktree is
 * kept — same as the existing archive action.
 */
export async function stopTask(env: StopTaskEnv, id: number): Promise<StopResult> {
  const task = env.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task | undefined;
  if (!task) return { ok: false, error: "notFound" };
  await env.killSession(task.session);
  env.db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(id);
  await env.writeManifest(id);
  return { ok: true };
}

// ---------- repo task ----------
// A skill delivered into a task's worktree: identity, display name, source dir.
export interface SkillRef {
  key: string;
  name: string;
  dir: string;
}

// The repo this task springs from. The owner already holds its mirror; the core
// derives the worktree path from it. (Not the full Repo row — just what we need.)
export interface RepoRef {
  id: number;
  name: string;
  mirror_path: string;
}

export interface RepoTaskEnv {
  db: DB;
  ns: string;
  // Persist the task's durable record. Injected (not a hardcoded local write) so
  // the caller owns the policy: the CLI verb writes to its own data dir (it IS the
  // owner); the HTTP route passes the ownership-gated syncTaskManifest so a task
  // orchestrated on a remote machine isn't manifested on the controller.
  writeManifest(id: number): void | Promise<void>;
  // Preflight the requested skill keys against the owner's sources.
  resolveSkills(keys: string[]): { found: SkillRef[]; missing: string[] };
  // Prepare the worktree's CONTENTS: create it from the base branch, deliver each
  // skill, inject the per-task hooks, and keep both out of git status. Grouped as
  // one seam — the prod env fills it with the real git/putDir/exclude/hooks code.
  setupWorktree(args: {
    id: number;
    mirror: string;
    worktree: string;
    workBranch: string;
    baseBranch: string;
    skills: SkillRef[];
  }): Promise<void>;
  // Launch claude in the worktree (opening = freeform prompt + skills line, or null).
  // env (optional) injects ANTHROPIC_* vars to point claude at an alternate model
  // backend; omitted/undefined → the machine's default claude login.
  startSession(session: string, worktree: string, opening: string | null, env?: Record<string, string>): Promise<void>;
  // Tear down a partially-built worktree after a failed dispatch.
  removeWorktree(mirror: string, worktree: string, workBranch: string): Promise<void>;
}

export interface CreateRepoOpts {
  baseBranch: string;
  title: string;
  prompt?: string | null;
  extraSkills?: string[];
  // Alternate model backend (optional). providerId is recorded on the task (so
  // resume can re-inject the same backend); env is the resolved ANTHROPIC_* vars
  // injected when claude launches. Both omitted → default claude login. Only the
  // in-process caller sets these; the CLI/fleet caller leaves them undefined.
  providerId?: number | null;
  env?: Record<string, string>;
}

export type CreateRepoResult =
  | { ok: true; id: number; session: string; workBranch: string }
  | { ok: false; error: "skillsMissing"; missing: string[] }
  | { ok: false; error: "dispatchFailed"; id: number; message: string };

/**
 * Create a repo task ON the owner: preflight skills, insert the row, prepare the
 * worktree + session, then flip to running and write the manifest. A failure
 * after the row exists removes the partial worktree and marks the task errored
 * (still manifested). Mirrors index.ts's POST /api/tasks exactly — the HTTP route
 * becomes a thin caller, and a future `tdsp create` verb reuses this verbatim.
 */
export async function createRepoTask(env: RepoTaskEnv, repo: RepoRef, opts: CreateRepoOpts): Promise<CreateRepoResult> {
  // Preflight skills BEFORE inserting, so a bad skill never leaves a half-built
  // task pointing at a nonexistent skill.
  const wantKeys = [...new Set((opts.extraSkills ?? []).map(String))];
  const { found, missing } = env.resolveSkills(wantKeys);
  if (missing.length) return { ok: false, error: "skillsMissing", missing };

  const info = env.db
    .prepare(
      "INSERT INTO tasks (repo_id, base_branch, work_branch, title, prompt, worktree_path, session, status, skills, provider_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run(repo.id, opts.baseBranch, "", opts.title, opts.prompt || null, "", "", "creating", JSON.stringify(found.map((f) => f.key)), opts.providerId ?? null);
  const id = Number(info.lastInsertRowid);
  const s = slug(opts.title);
  const workBranch = `feat/${id}-${s}`;
  const worktree = path.resolve(path.join(path.dirname(repo.mirror_path), "..", "worktrees", `${repo.id}-${id}`));
  const session = `tdsp-${env.ns}-${id}-${slug(repo.name)}-${s}`;

  try {
    await env.setupWorktree({ id, mirror: repo.mirror_path, worktree, workBranch, baseBranch: opts.baseBranch, skills: found });
    // opening = freeform prompt + the "skills delivered" line; pass it UNTRIMMED
    // (only the null-decision uses trim) to match the prior HTTP behavior exactly.
    const opening = (opts.prompt || "") + skillsLine(found.map((f) => f.name));
    await env.startSession(session, worktree, opening.trim() ? opening : null, opts.env);
    env.db.prepare("UPDATE tasks SET work_branch=?, worktree_path=?, session=?, status='running' WHERE id=?").run(workBranch, worktree, session, id);
    await env.writeManifest(id);
    return { ok: true, id, session, workBranch };
  } catch (e: any) {
    // a partial dispatch (e.g. session start failed after the worktree was made)
    // would orphan the worktree — remove it so nothing is left behind
    await env.removeWorktree(repo.mirror_path, worktree, workBranch).catch(() => {});
    env.db.prepare("UPDATE tasks SET status='error', error=? WHERE id=?").run(String(e?.message || e), id);
    await env.writeManifest(id);
    return { ok: false, error: "dispatchFailed", id, message: String(e?.message || e) };
  }
}
