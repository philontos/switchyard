// Pure helpers for the "paste a screenshot into a task" feature. No I/O, no DB
// import — just the path/mime logic, so it's trivially unit-testable. The
// endpoint (index.ts) wires these to the Runner (land the file on the task's
// machine) and tmux (bracketed-paste the path so claude attaches it as an image).
import path from "node:path";

// Clipboard screenshots are PNG; allow the few other web image types too. The
// value is the on-disk extension claude needs to recognize the file as an image.
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Map a Content-Type to an image extension, or null if it's not an allowed image. */
export function extForMime(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  return MIME_EXT[mime] ?? null;
}

/**
 * Where a task's pasted images live ON its machine: a repo task uses its
 * worktree, a repo-less local task uses its cwd. Null when neither is set
 * (e.g. a half-created task with no workdir yet).
 */
export function pasteTargetBase(task: { worktree_path?: string | null; cwd?: string | null }): string | null {
  const wt = task.worktree_path?.trim();
  if (wt) return wt;
  const cwd = task.cwd?.trim();
  if (cwd) return cwd;
  return null;
}

/** Absolute dest for one pasted image, under <base>/.claude/pasted/. */
export function pastedDest(base: string, filename: string): string {
  return path.join(base, ".claude", "pasted", filename);
}

/** Stable, unique-ish filename for a pasted image (caller passes a timestamp). */
export function pasteFilename(stamp: number | string, ext: string): string {
  return `paste-${stamp}.${ext}`;
}
