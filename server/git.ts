import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { MIRRORS_DIR, WORKTREES_DIR } from "./paths.js";

const pexec = promisify(execFile);

export async function git(cwd: string | null, args: string[]) {
  const opts = { cwd: cwd ?? undefined, maxBuffer: 1024 * 1024 * 64 };
  const { stdout } = await pexec("git", args, opts);
  return stdout;
}

/** Embed token into an https git url for clone/fetch/push. */
export function authUrl(gitUrl: string, token?: string | null): string {
  if (!token) return gitUrl;
  try {
    const u = new URL(gitUrl);
    if (u.protocol !== "https:") return gitUrl;
    // GitLab accepts oauth2:<token>
    u.username = "oauth2";
    u.password = token;
    return u.toString();
  } catch {
    return gitUrl;
  }
}

export function mirrorPath(repoId: number, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(MIRRORS_DIR, `${repoId}-${safe}.git`);
}

export async function cloneMirror(gitUrl: string, token: string | null, dest: string) {
  fs.mkdirSync(MIRRORS_DIR, { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  await git(null, ["clone", "--mirror", authUrl(gitUrl, token), dest]);
}

export async function fetchMirror(mirror: string, gitUrl: string, token: string | null) {
  // refresh remote in case token rotated
  await git(mirror, ["remote", "set-url", "origin", authUrl(gitUrl, token)]).catch(() => {});
  await git(mirror, ["fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"]);
}

export async function listBranches(mirror: string): Promise<string[]> {
  const out = await git(mirror, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function addWorktree(mirror: string, dest: string, workBranch: string, baseBranch: string) {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  await git(mirror, ["worktree", "add", "-b", workBranch, dest, baseBranch]);
}

export async function removeWorktree(mirror: string, dest: string, workBranch?: string) {
  await git(mirror, ["worktree", "remove", "--force", dest]).catch(() => {
    // fall back to manual cleanup if worktree metadata is gone
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  });
  await git(mirror, ["worktree", "prune"]).catch(() => {});
  if (workBranch) {
    await git(mirror, ["branch", "-D", workBranch]).catch(() => {});
  }
}

/** Push the work branch from a worktree to origin and return the pushed ref. */
export async function pushBranch(worktree: string, workBranch: string) {
  await git(worktree, ["push", "-u", "origin", `HEAD:refs/heads/${workBranch}`]);
}
