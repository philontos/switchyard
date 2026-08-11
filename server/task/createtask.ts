// Task-creation orchestration, extracted so BOTH the HTTP route and the `tdsp`
// CLI verb run the exact same code. In the edge-autonomy model a node only ever
// creates tasks ON ITSELF — so the orchestration is always local; the machine,
// shell-starter and cwd-check are injected (real localRunner in prod, fakes in
// tests). The durable record is the manifest, written here as the single writer.
import path from "node:path";
import { writeTaskManifestFromDb } from "./taskmanifest.js";
import { resolveCwd } from "../fleet/local.js";
import type { AgentKind } from "../session/agent.js";
import type Database from "better-sqlite3";
import { getOwnedTask } from "../core/ownership.js";
import {
  kimiWorkspaceAgentPath,
  referenceRootPath,
  resolveReferenceInputs,
  TASK_WORKSPACE_INSTRUCTIONS,
  type TaskReferenceInput,
} from "./references.js";

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

  const manifest = () => writeTaskManifestFromDb(env.dataDir, env.db, id);
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
  const task = getOwnedTask(env.db, id);
  if (!task) return { ok: false, error: "notFound" };
  await env.killSession(task.session);
  env.db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(id);
  await env.writeManifest(id);
  return { ok: true };
}

// ---------- repo task ----------
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
  // Persist the task's durable record. Both the CLI verb and HTTP route execute
  // on the owner and inject their node-local manifest writer.
  writeManifest(id: number): void | Promise<void>;
  // Prepare the worktree's contents: create it from the base branch and inject
  // the per-task Claude hooks. Grouped as one seam so orchestration remains
  // independent of git and filesystem mechanics.
  setupWorktree(args: {
    id: number;
    mirror: string;
    worktree: string;
    workBranch: string;
    baseBranch: string;
    agent: AgentKind;
  }): Promise<string>; // exact HEAD immediately after worktree creation
  // Create an atomically published, commit-pinned plain-code snapshot for one
  // referenced repository.
  setupReference(args: {
    mirror: string;
    worktree: string;
    requestedRef: string;
  }): Promise<string>;
  // Launch the agent in the worktree (opening = freeform prompt or null).
  // opts.env injects ANTHROPIC_* vars for claude's alternate model backend;
  // opts.agent picks the CLI (claude default | codex | kimi); opts.model is the
  // non-Claude -m model. All omitted → the machine's default claude login.
  startSession(
    session: string,
    worktree: string,
    opening: string | null,
    opts?: {
      env?: Record<string, string>;
      agent?: AgentKind;
      model?: string | null;
      addDirs?: string[];
      workspaceInstructions?: string;
      kimiAgentFile?: string;
    },
  ): Promise<void>;
  // Tear down a partially-built worktree after a failed dispatch.
  removeWorktree(mirror: string, worktree: string, workBranch: string): Promise<void>;
  removeReference(mirror: string, worktree: string): Promise<void>;
  removeReferenceRoots(taskId: number, taskWorktree: string): Promise<void>;
}

export interface CreateRepoOpts {
  baseBranch: string;
  title: string;
  prompt?: string | null;
  // Alternate model backend (optional). providerId is recorded on the task (so
  // resume can re-inject the same backend); env is the resolved ANTHROPIC_* vars
  // injected when claude launches. Both omitted → default claude login. Only the
  // in-process caller sets these; the CLI/fleet caller leaves them undefined.
  providerId?: number | null;
  env?: Record<string, string>;
  // Which coding-agent CLI runs the task (claude default | codex | kimi) and the
  // optional non-Claude -m model. Recorded so resume rebuilds the same launch.
  agent?: AgentKind;
  model?: string | null;
  references?: TaskReferenceInput[];
}

export type CreateRepoResult =
  | { ok: true; id: number; session: string; workBranch: string }
  | { ok: false; error: "invalidReference"; message: string }
  | { ok: false; error: "dispatchFailed"; id: number; message: string };

/**
 * Create a repo task ON the owner: insert the row, prepare the worktree +
 * session, then flip to running and write the manifest. A failure
 * after the row exists removes the partial worktree and marks the task errored
 * (still manifested). Mirrors index.ts's POST /api/tasks exactly — the HTTP route
 * becomes a thin caller, and a future `tdsp create` verb reuses this verbatim.
 */
export async function createRepoTask(env: RepoTaskEnv, repo: RepoRef, opts: CreateRepoOpts): Promise<CreateRepoResult> {
  const agent = opts.agent ?? "claude";
  const resolvedReferences = resolveReferenceInputs(env.db, opts.references);
  if (!resolvedReferences.ok) {
    return { ok: false, error: "invalidReference", message: resolvedReferences.error };
  }
  if (resolvedReferences.references.some((reference) => reference.repo.id === repo.id)) {
    return { ok: false, error: "invalidReference", message: "the primary repository cannot also be a task reference" };
  }
  const info = env.db
    .prepare(
      "INSERT INTO tasks (repo_id, base_branch, work_branch, title, prompt, worktree_path, session, status, provider_id, agent, agent_model) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(repo.id, opts.baseBranch, "", opts.title, opts.prompt || null, "", "", "creating", opts.providerId ?? null, agent, opts.model ?? null);
  const id = Number(info.lastInsertRowid);
  const s = slug(opts.title);
  const workBranch = `feat/${id}-${s}`;
  const worktree = path.resolve(path.join(path.dirname(repo.mirror_path), "..", "worktrees", `${repo.id}-${id}`));
  const referenceRoot = referenceRootPath(worktree);
  const session = `tdsp-${env.ns}-${id}-${slug(repo.name)}-${s}`;
  const materialized: Array<{
    task_id: number;
    repo_id: number;
    alias: string;
    repo_name: string;
    mirror_path: string;
    requested_ref: string;
    resolved_commit: string;
    worktree_path: string;
    mode: "reference";
  }> = [];
  const referenceCleanup: Array<{ mirror: string; worktree: string }> = [];

  try {
    const baseCommit = await env.setupWorktree({ id, mirror: repo.mirror_path, worktree, workBranch, baseBranch: opts.baseBranch, agent });
    for (const reference of resolvedReferences.references) {
      const referenceWorktree = path.join(referenceRoot, reference.alias);
      referenceCleanup.push({ mirror: reference.repo.mirror_path, worktree: referenceWorktree });
      const commit = await env.setupReference({
        mirror: reference.repo.mirror_path,
        worktree: referenceWorktree,
        requestedRef: reference.requested_ref,
      });
      materialized.push({
        task_id: id,
        repo_id: reference.repo.id,
        alias: reference.alias,
        repo_name: reference.repo.name,
        mirror_path: reference.repo.mirror_path,
        requested_ref: reference.requested_ref,
        resolved_commit: commit,
        worktree_path: referenceWorktree,
        mode: "reference",
      });
    }
    if (materialized.length) {
      const insert = env.db.prepare(
        "INSERT INTO task_references " +
          "(task_id,repo_id,alias,requested_ref,resolved_commit,worktree_path,mode) VALUES (?,?,?,?,?,?,?)",
      );
      env.db.transaction(() => {
        for (const reference of materialized) {
          insert.run(
            reference.task_id,
            reference.repo_id,
            reference.alias,
            reference.requested_ref,
            reference.resolved_commit,
            reference.worktree_path,
            reference.mode,
          );
        }
      })();
    }
    // Publish the initial dynamic manifest before the agent can receive its
    // first prompt. The row remains `creating` until tmux is confirmed alive.
    env.db.prepare("UPDATE tasks SET base_commit=?, work_branch=?, worktree_path=?, session=? WHERE id=?")
      .run(baseCommit, workBranch, worktree, session, id);
    await env.writeManifest(id);

    const opening = opts.prompt?.trim() ? opts.prompt : null;
    await env.startSession(session, worktree, opening, {
      env: opts.env,
      agent,
      model: opts.model,
      workspaceInstructions: TASK_WORKSPACE_INSTRUCTIONS,
      kimiAgentFile: kimiWorkspaceAgentPath(worktree),
    });
    env.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(id);
    await env.writeManifest(id);
    return { ok: true, id, session, workBranch };
  } catch (e: any) {
    // a partial dispatch (e.g. session start failed after the worktree was made)
    // would orphan the worktree — remove it so nothing is left behind
    for (const reference of [...referenceCleanup].reverse()) {
      await env.removeReference(reference.mirror, reference.worktree).catch(() => {});
    }
    await env.removeReferenceRoots(id, worktree).catch(() => {});
    env.db.prepare("DELETE FROM task_references WHERE task_id=?").run(id);
    await env.removeWorktree(repo.mirror_path, worktree, workBranch).catch(() => {});
    env.db.prepare(
      "UPDATE tasks SET base_commit=NULL, work_branch='', worktree_path='', session='', status='error', error=? WHERE id=?",
    ).run(String(e?.message || e), id);
    await env.writeManifest(id);
    return { ok: false, error: "dispatchFailed", id, message: String(e?.message || e) };
  }
}
