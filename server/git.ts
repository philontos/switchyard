import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { MIRRORS_DIR, WORKTREES_DIR } from "./paths.js";

const pexec = promisify(execFile);

export async function git(cwd: string | null, args: string[]) {
  const opts = {
    cwd: cwd ?? undefined,
    maxBuffer: 1024 * 1024 * 64,
    env: {
      ...process.env,
      // never hang the server on an interactive SSH/host-key/credential prompt;
      // fail fast with a readable error instead.
      GIT_SSH_COMMAND:
        process.env.GIT_SSH_COMMAND ||
        "ssh -o BatchMode=yes -o ConnectTimeout=15",
      GIT_TERMINAL_PROMPT: "0",
    },
  };
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

/**
 * Register a repo locally WITHOUT downloading any objects: create an empty
 * bare repo, point it at origin, and validate connectivity via ls-remote.
 * Objects for a branch are only fetched later, at dispatch time.
 */
export async function initMirror(gitUrl: string, token: string | null, dest: string) {
  fs.mkdirSync(MIRRORS_DIR, { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  await git(null, ["init", "--bare", dest]);
  await git(dest, ["remote", "add", "origin", authUrl(gitUrl, token)]);
  await git(dest, ["ls-remote", "--heads", "origin"]); // throws on bad url/auth/host
}

/** Live list of remote branches — always current, no local staleness. */
export async function listBranches(mirror: string): Promise<string[]> {
  const out = await git(mirror, ["ls-remote", "--heads", "origin"]);
  return out
    .split("\n")
    .map((l) => l.trim().split("\t")[1])
    .filter(Boolean)
    .map((ref) => ref.replace(/^refs\/heads\//, ""));
}

/**
 * Fetch just one branch's LATEST commit (shallow, depth 1) into the local bare
 * repo at dispatch time. Shallow keeps it to a few MB / seconds instead of
 * pulling the branch's full history. Push/MR still work against the remote.
 */
export async function fetchBranch(mirror: string, branch: string) {
  await git(mirror, ["fetch", "--depth", "1", "origin", `+refs/heads/${branch}:refs/heads/${branch}`]);
}

/** Manual full refresh of all branches (the repo card's "fetch" button). */
export async function fetchMirror(mirror: string, gitUrl: string, token: string | null) {
  await git(mirror, ["remote", "set-url", "origin", authUrl(gitUrl, token)]).catch(() => {});
  await git(mirror, ["fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"]);
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
