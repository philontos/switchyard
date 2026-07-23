// The "which agent" axis. A task runs under one coding-agent CLI: `claude`
// (the default, unchanged), `codex`, or `kimi`. Every Claude-specific launch detail is
// funnelled through here, so the orchestration code stays agent-agnostic:
//   - agentArgv: how to launch / resume the agent (the command + its args)
// Claude's launch is byte-for-byte what it always was.
export type AgentKind = "claude" | "codex" | "kimi";

/** Normalize an untrusted value to an AgentKind. Only known exact strings opt in;
 *  anything else (missing, blank, garbage) is the default "claude" — never throws. */
export function asAgentKind(s: unknown): AgentKind {
  return s === "codex" || s === "kimi" ? s : "claude";
}

export interface LaunchOpts {
  /** freeform opening message; blank/whitespace is treated as "no prompt" */
  prompt?: string | null;
  /** codex/kimi: passed as `-m <model>`. claude ignores it (its model rides the
   *  provider ANTHROPIC_* env, not a CLI flag). */
  model?: string | null;
  /** resume the prior conversation in this cwd instead of starting fresh */
  resume?: boolean;
  /** codex/kimi: extra writable roots (`--add-dir`), e.g. a linked worktree's gitdir.
   *  Redundant under `-s danger-full-access` (the sandbox is off) but harmless;
   *  kept so the plumbing survives if the sandbox is ever tightened again. */
  addDirs?: string[];
}

const hasText = (s?: string | null): s is string => !!s && !!s.trim();
const addDirArgs = (dirs?: string[]) => (dirs ?? []).flatMap((d) => hasText(d) ? ["--add-dir", d.trim()] : []);

/**
 * Build the agent's launch argv — the binary plus its args, WITHOUT the tmux
 * `new-session` shell or the `env K=V` provider prefix (tmux.ts wraps those).
 *
 * claude: `claude <prompt>` / `claude --continue` (resume keys by cwd).
 * codex:  full-access (`-a on-request -s danger-full-access`) so tasks can push,
 *         run gh, and reach the network. The sandbox is off, so `on-request`
 *         rarely pauses (nothing left to escalate) — but note codex has no
 *         waiting-hook, so any pause it does make is invisible to the dispatcher.
 *         Resume is `codex resume --last` (cwd-filtered, most recent).
 * kimi:   interactive Kimi Code TUI with `--auto` so normal tool approvals are
 *         handled by the CLI. Initial prompts are submitted after launch by tmux
 *         (see startSession) because `kimi -p` is documented as non-interactive
 *         and exits after a single prompt. Resume is `kimi --continue --auto`.
 */
export function agentArgv(agent: AgentKind, opts: LaunchOpts = {}): string[] {
  if (agent === "codex") {
    const base = ["codex", "-a", "on-request", "-s", "danger-full-access", ...addDirArgs(opts.addDirs)];
    if (opts.resume) return [...base, "resume", "--last"];
    const argv = [...base];
    if (hasText(opts.model)) argv.push("-m", opts.model.trim());
    if (hasText(opts.prompt)) argv.push(opts.prompt);
    return argv;
  }
  if (agent === "kimi") {
    const base = ["kimi", "--auto", ...addDirArgs(opts.addDirs)];
    if (opts.resume) return [...base, "--continue"];
    const argv = [...base];
    if (hasText(opts.model)) argv.push("-m", opts.model.trim());
    return argv;
  }
  // claude
  if (opts.resume) return ["claude", "--continue"];
  return hasText(opts.prompt) ? ["claude", opts.prompt] : ["claude"];
}
