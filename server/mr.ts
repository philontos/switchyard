import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/**
 * Create a merge request via glab. Requires `glab auth login` to be done once,
 * or GITLAB_TOKEN in env. Returns the MR url parsed from glab output.
 */
export async function createMR(opts: {
  worktree: string;
  projectPath?: string | null;
  source: string;
  target: string;
  title: string;
}): Promise<string> {
  const args = [
    "mr", "create",
    "--source-branch", opts.source,
    "--target-branch", opts.target,
    "--title", opts.title,
    "--description", "Created by task-dispatcher",
    "--yes",
  ];
  if (opts.projectPath) args.push("--repo", opts.projectPath);
  const { stdout, stderr } = await pexec("glab", args, { cwd: opts.worktree });
  const text = stdout + "\n" + stderr;
  const m = text.match(/https?:\/\/\S+\/-\/merge_requests\/\d+/);
  if (m) return m[0];
  const any = text.match(/https?:\/\/\S+/);
  return any ? any[0] : text.trim();
}
