import path from "node:path";
import { MIRRORS_DIR, WORKTREES_DIR } from "./paths.js";
import { Runner } from "./runner.js";

// Run a git command through the given machine's Runner. The env keeps git from
// hanging on an interactive SSH/host-key/credential prompt — fail fast instead.
async function git(runner: Runner, cwd: string | null, args: string[]): Promise<string> {
  return runner.exec("git", args, {
    cwd: cwd ?? undefined,
    env: {
      ...process.env,
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=15",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
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
export async function initMirror(runner: Runner, gitUrl: string, token: string | null, dest: string) {
  await runner.mkdirp(MIRRORS_DIR);
  if (await runner.exists(dest)) await runner.rmrf(dest);
  await git(runner, null, ["init", "--bare", dest]);
  await git(runner, dest, ["remote", "add", "origin", authUrl(gitUrl, token)]);
  await git(runner, dest, ["ls-remote", "--heads", "origin"]); // throws on bad url/auth/host
}

/** Live list of remote branches — always current, no local staleness. */
export async function listBranches(runner: Runner, mirror: string): Promise<string[]> {
  const out = await git(runner, mirror, ["ls-remote", "--heads", "origin"]);
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
export async function fetchBranch(runner: Runner, mirror: string, branch: string) {
  await git(runner, mirror, ["fetch", "--depth", "1", "origin", `+refs/heads/${branch}:refs/heads/${branch}`]);
}

/** Manual full refresh of all branches (the repo card's "fetch" button). */
export async function fetchMirror(runner: Runner, mirror: string, gitUrl: string, token: string | null) {
  await git(runner, mirror, ["remote", "set-url", "origin", authUrl(gitUrl, token)]).catch(() => {});
  await git(runner, mirror, ["fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"]);
}

export async function addWorktree(runner: Runner, mirror: string, dest: string, workBranch: string, baseBranch: string) {
  await runner.mkdirp(WORKTREES_DIR);
  await git(runner, mirror, ["worktree", "add", "-b", workBranch, dest, baseBranch]);
}

export async function removeWorktree(runner: Runner, mirror: string, dest: string, workBranch?: string) {
  await git(runner, mirror, ["worktree", "remove", "--force", dest]).catch(async () => {
    // fall back to manual cleanup if worktree metadata is gone
    if (await runner.exists(dest)) await runner.rmrf(dest);
  });
  await git(runner, mirror, ["worktree", "prune"]).catch(() => {});
  if (workBranch) {
    await git(runner, mirror, ["branch", "-D", workBranch]).catch(() => {});
  }
}
