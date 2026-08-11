// The "which agent" axis. A task runs under one coding-agent CLI: `claude`
// (the default, unchanged), `codex`, or `kimi`. Every Claude-specific launch detail is
// funnelled through here, so the orchestration code stays agent-agnostic:
//   - agentArgv: how to launch / resume the agent (the command + its args)
// Provider-specific persistent workspace instructions are also centralized here.
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
  /** Additional workspace roots translated to each agent CLI's `--add-dir`.
   *  For codex/kimi this also carries linked-worktree Git metadata directories. */
  addDirs?: string[];
  /** Stable Switchyard workspace contract installed on every launch/resume. */
  workspaceInstructions?: string | null;
  /** Kimi binds a custom main-agent file when the session is first created;
   * resumes restore that bound agent and reject this option. */
  kimiAgentFile?: string | null;
}

const hasText = (s?: string | null): s is string => !!s && !!s.trim();
const addDirArgs = (dirs?: string[]) => (dirs ?? []).flatMap((d) => hasText(d) ? ["--add-dir", d.trim()] : []);
const claudeAddDirArgs = (dirs?: string[]) => {
  const clean = (dirs ?? []).filter(hasText).map((dir) => dir.trim());
  return clean.length ? ["--add-dir", ...clean] : [];
};

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
    const instructions = hasText(opts.workspaceInstructions)
      ? ["-c", `developer_instructions=${JSON.stringify(opts.workspaceInstructions)}`]
      : [];
    const base = [
      "codex", "-a", "on-request", "-s", "danger-full-access",
      ...instructions,
      ...addDirArgs(opts.addDirs),
    ];
    if (hasText(opts.model)) base.push("-m", opts.model.trim());
    if (opts.resume) return [...base, "resume", "--last"];
    const argv = [...base];
    if (hasText(opts.prompt)) argv.push(opts.prompt);
    return argv;
  }
  if (agent === "kimi") {
    const boundAgent = !opts.resume && hasText(opts.kimiAgentFile)
      ? ["--agent-file", opts.kimiAgentFile.trim()]
      : [];
    const base = ["kimi", "--auto", ...boundAgent, ...addDirArgs(opts.addDirs)];
    if (hasText(opts.model)) base.push("-m", opts.model.trim());
    if (opts.resume) return [...base, "--continue"];
    const argv = [...base];
    return argv;
  }
  // Claude's --add-dir is variadic (one flag followed by every directory),
  // unlike Codex/Kimi's repeatable single-dir option. `--` terminates that
  // variadic value before the positional opening prompt.
  const instructions = hasText(opts.workspaceInstructions)
    ? ["--append-system-prompt", opts.workspaceInstructions]
    : [];
  const dirs = claudeAddDirArgs(opts.addDirs);
  if (opts.resume) return ["claude", "--continue", ...instructions, ...dirs];
  if (!hasText(opts.prompt)) return ["claude", ...instructions, ...dirs];
  return dirs.length
    ? ["claude", ...instructions, ...dirs, "--", opts.prompt]
    : ["claude", ...instructions, opts.prompt];
}
