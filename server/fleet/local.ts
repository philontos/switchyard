// Local (repo-less) quick tasks: a dispatched claude session that skips the
// git mirror/worktree machinery and just runs in a plain directory.
import path from "node:path";

/**
 * Resolve a user-typed working dir into an absolute path. Blank → home;
 * a leading ~ expands to home; an absolute path is kept; anything else is
 * treated as relative to home. Existence is the caller's concern.
 */
export function resolveCwd(input: string | null | undefined, home: string): string {
  const raw = (input ?? "").trim();
  if (!raw || raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  if (path.isAbsolute(raw)) return raw;
  return path.join(home, raw);
}
