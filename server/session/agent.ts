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
// share — so codex opts out of both. codex also has no waiting-hook: with
// `-a on-request` it can pause for an approval the dispatcher can't see (a known
// gap), though `-s danger-full-access` makes that pause rare (see agentArgv).
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
  /** codex: extra writable roots (`--add-dir`), e.g. a linked worktree's gitdir.
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
  // claude
  if (opts.resume) return ["claude", "--continue"];
  return hasText(opts.prompt) ? ["claude", opts.prompt] : ["claude"];
}
