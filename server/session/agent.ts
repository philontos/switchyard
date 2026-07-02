// The "which agent" axis. A task runs under one coding-agent CLI: `claude`
// (the default, unchanged) or `codex`. Every Claude-specific launch detail is
// funnelled through here, so the orchestration code stays agent-agnostic:
//   - agentArgv:  how to launch / resume the agent (the command + its args)
//   - agentCaps:  which worktree injections apply (skills, the yellow-light hook)
// Claude's launch is byte-for-byte what it always was; codex is the new branch.
export type AgentKind = "claude" | "codex";

export const AGENT_KINDS: readonly AgentKind[] = ["claude", "codex"];

/** Normalize an untrusted value to an AgentKind. Only the exact "codex" opts in;
 *  anything else (missing, blank, garbage) is the default "claude" — never throws. */
export function asAgentKind(s: unknown): AgentKind {
  return s === "codex" ? "codex" : "claude";
}

export interface AgentCaps {
  /** deliver each selected skill's dir into the worktree's .claude/skills/ */
  injectSkills: boolean;
  /** inject the .claude/settings.local.json hook that powers the yellow "waiting
   *  on a permission prompt" light (and captures the session id) */
  injectHooks: boolean;
}

// Both injections hang off Claude's .claude/ conventions, which codex doesn't
// share — so codex opts out of both. codex runs full-auto instead (see agentArgv),
// which is why it never needs the waiting-hook.
export function agentCaps(agent: AgentKind): AgentCaps {
  return agent === "codex"
    ? { injectSkills: false, injectHooks: false }
    : { injectSkills: true, injectHooks: true };
}

export interface LaunchOpts {
  /** freeform opening message; blank/whitespace is treated as "no prompt" */
  prompt?: string | null;
  /** codex: passed as `-m <model>`. claude ignores it (its model rides the
   *  provider ANTHROPIC_* env, not a CLI flag). */
  model?: string | null;
  /** resume the prior conversation in this cwd instead of starting fresh */
  resume?: boolean;
}

const hasText = (s?: string | null): s is string => !!s && !!s.trim();

/**
 * Build the agent's launch argv — the binary plus its args, WITHOUT the tmux
 * `new-session` shell or the `env K=V` provider prefix (tmux.ts wraps those).
 *
 * claude: `claude <prompt>` / `claude --continue` (resume keys by cwd).
 * codex:  full-auto (`-a never -s workspace-write`) so it never stalls on an
 *         approval prompt the dispatcher couldn't detect; resume is
 *         `codex resume --last` (cwd-filtered, most recent).
 */
export function agentArgv(agent: AgentKind, opts: LaunchOpts = {}): string[] {
  if (agent === "codex") {
    if (opts.resume) return ["codex", "resume", "--last"];
    const argv = ["codex", "-a", "never", "-s", "workspace-write"];
    if (hasText(opts.model)) argv.push("-m", opts.model.trim());
    if (hasText(opts.prompt)) argv.push(opts.prompt);
    return argv;
  }
  // claude
  if (opts.resume) return ["claude", "--continue"];
  return hasText(opts.prompt) ? ["claude", opts.prompt] : ["claude"];
}
