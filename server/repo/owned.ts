import type Database from "better-sqlite3";
import type { Repo, Task } from "../core/db.js";
import type { Runner } from "../fleet/runner.js";
import { getOwnedRepo, localHostId } from "../core/ownership.js";
import { findRepoByGitUrl } from "./catalog.js";
import { fetchMirror, initMirror, listBranches, mirrorPath, removeWorktree } from "./git.js";

type DB = Database.Database;

export interface OwnedRepoInput {
  name?: string | null;
  git_url?: string | null;
  token?: string | null;
  default_branch?: string | null;
  project_path?: string | null;
}

export type OwnedRepoResult =
  | { ok: true; id: number; existing: boolean; retrying: boolean; status: "ready" }
  | { ok: false; error: "fieldsRequired" | "notFound" | "notReady" | "hasLiveTasks" | "operationFailed"; message?: string; liveCount?: number };

export type OwnedRepoFailure = Extract<OwnedRepoResult, { ok: false }>;

export interface OwnedRepoEnv {
  db: DB;
  runner: Runner;
  syncRepos(): void;
  removeTaskManifest(id: number): void;
  killSession(session: string): Promise<void>;
}

function messageOf(error: unknown): string {
  return String((error as any)?.message || error);
}

function requireOwnerRunner(env: OwnedRepoEnv): OwnedRepoFailure | null {
  return env.runner.kind === "local"
    ? null
    : { ok: false, error: "operationFailed", message: "Repository operations must run on the owning node" };
}

/** Register and validate a repository entirely on the owning node. */
export async function registerOwnedRepo(env: OwnedRepoEnv, input: OwnedRepoInput): Promise<OwnedRepoResult> {
  const runnerFailure = requireOwnerRunner(env);
  if (runnerFailure) return runnerFailure;
  const name = String(input.name || "").trim();
  const gitUrl = String(input.git_url || "").trim();
  if (!name || !gitUrl) return { ok: false, error: "fieldsRequired" };
  const hostId = localHostId(env.db);
  if (hostId == null) return { ok: false, error: "operationFailed", message: "local node is not initialized" };
  const existing = findRepoByGitUrl(env.db, hostId, gitUrl);
  if (existing && existing.status !== "error") {
    return { ok: true, id: existing.id, existing: true, retrying: false, status: "ready" };
  }

  let id: number;
  let dest: string;
  if (existing) {
    id = existing.id;
    dest = existing.mirror_path || mirrorPath(env.runner.dataDir, id, name);
    env.db.prepare(
      "UPDATE repos SET name=?,git_url=?,token=?,default_branch=?,project_path=?,mirror_path=?,status='cloning',error=NULL WHERE id=?",
    ).run(name, gitUrl, input.token || null, input.default_branch || "main", input.project_path || null, dest, id);
  } else {
    const info = env.db.prepare(
      "INSERT INTO repos (host_id,name,git_url,token,default_branch,project_path,status) VALUES (?,?,?,?,?,?,?)",
    ).run(hostId, name, gitUrl, input.token || null, input.default_branch || "main", input.project_path || null, "cloning");
    id = Number(info.lastInsertRowid);
    dest = mirrorPath(env.runner.dataDir, id, name);
    env.db.prepare("UPDATE repos SET mirror_path=? WHERE id=?").run(dest, id);
  }
  env.syncRepos();

  try {
    await initMirror(env.runner, gitUrl, input.token || null, dest);
    env.db.prepare("UPDATE repos SET status='ready',error=NULL WHERE id=?").run(id);
    env.syncRepos();
    return { ok: true, id, existing: !!existing, retrying: !!existing, status: "ready" };
  } catch (error) {
    const message = messageOf(error);
    env.db.prepare("UPDATE repos SET status='error',error=? WHERE id=?").run(message, id);
    env.syncRepos();
    return { ok: false, error: "operationFailed", message };
  }
}

export async function fetchOwnedRepo(env: OwnedRepoEnv, id: number): Promise<OwnedRepoResult> {
  const runnerFailure = requireOwnerRunner(env);
  if (runnerFailure) return runnerFailure;
  const repo = getOwnedRepo(env.db, id);
  if (!repo?.mirror_path) return { ok: false, error: "notFound" };
  try {
    await fetchMirror(env.runner, repo.mirror_path, repo.git_url, repo.token);
    return { ok: true, id: repo.id, existing: true, retrying: false, status: "ready" };
  } catch (error) {
    return { ok: false, error: "operationFailed", message: messageOf(error) };
  }
}

export async function branchesForOwnedRepo(env: OwnedRepoEnv, id: number): Promise<{ ok: true; branches: string[] } | OwnedRepoFailure> {
  const runnerFailure = requireOwnerRunner(env);
  if (runnerFailure) return runnerFailure;
  const repo = getOwnedRepo(env.db, id);
  if (!repo?.mirror_path) return { ok: false, error: "notFound" };
  if (repo.status !== "ready") return { ok: false, error: "notReady", message: repo.status };
  try {
    return { ok: true, branches: await listBranches(env.runner, repo.mirror_path) };
  } catch (error) {
    return { ok: false, error: "operationFailed", message: messageOf(error) };
  }
}

export async function deleteOwnedRepo(env: OwnedRepoEnv, id: number, force = false): Promise<OwnedRepoResult> {
  const runnerFailure = requireOwnerRunner(env);
  if (runnerFailure) return runnerFailure;
  const repo = getOwnedRepo(env.db, id);
  if (!repo) return { ok: false, error: "notFound" };
  const tasks = env.db.prepare("SELECT * FROM tasks WHERE repo_id=?").all(repo.id) as Task[];
  const live = tasks.filter((task) => task.status !== "cleaned");
  if (live.length && !force) return { ok: false, error: "hasLiveTasks", liveCount: live.length };

  try {
    for (const task of tasks) {
      if (task.session) await env.killSession(task.session).catch(() => {});
      if (task.worktree_path && repo.mirror_path && (await env.runner.exists(task.worktree_path).catch(() => false))) {
        await removeWorktree(env.runner, repo.mirror_path, task.worktree_path, task.work_branch);
      }
      env.removeTaskManifest(task.id);
    }
    env.db.prepare("DELETE FROM tasks WHERE repo_id=?").run(repo.id);
    if (repo.mirror_path) await env.runner.rmrf(repo.mirror_path).catch(() => {});
    env.db.prepare("DELETE FROM repos WHERE id=?").run(repo.id);
    env.syncRepos();
    return { ok: true, id: repo.id, existing: true, retrying: false, status: "ready" };
  } catch (error) {
    return { ok: false, error: "operationFailed", message: messageOf(error) };
  }
}
