// Pure helpers for the "paste a screenshot into a task" feature. No I/O, no DB
// import — just the path/mime/agent-adapter logic, so it's trivially
// unit-testable. The HTTP endpoint wires these to the Runner (land the file on
// the task's machine) and tmux (bracketed-paste whatever the target CLI expects).
import path from "node:path";
import type { AgentKind } from "../session/agent.js";

// Clipboard screenshots are PNG; allow the few other web image types too. The
// value is the on-disk extension the target CLI needs to recognize the file as
// an image.
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

export interface ImagePasteAdapter {
  /** Relative directory under the task cwd/worktree where pasted images land. */
  storageDir: string;
  /** Pattern added to .git/info/exclude so pasted images stay out of git status. */
  gitExcludePattern: string;
  /** Text bracketed-pasted into the CLI after the image has landed. */
  inputText: (imagePath: string) => string;
}

const ADAPTERS: Record<AgentKind, ImagePasteAdapter> = {
  // Claude Code turns a bracketed-pasted image path into an inline attachment.
  claude: {
    storageDir: path.join(".claude", "pasted"),
    gitExcludePattern: ".claude/pasted/",
    inputText: (imagePath) => imagePath,
  },
  // Codex CLI documents image attachments for initial prompts and interactive
  // composer paste. Through this web tmux bridge we can only inject text, so keep
  // Codex's storage and prompt wording isolated here until a native attachment
  // transport is added.
  codex: {
    storageDir: path.join(".codex", "pasted"),
    gitExcludePattern: ".codex/pasted/",
    inputText: (imagePath) => `Use this image as visual context: ${imagePath}`,
  },
};

export function imagePasteAdapter(agent: AgentKind): ImagePasteAdapter {
  return ADAPTERS[agent];
}

/** Absolute dest for one pasted image under the adapter's storage dir. */
export function pastedDest(base: string, filename: string, agent: AgentKind = "claude"): string {
  return path.join(base, imagePasteAdapter(agent).storageDir, filename);
}

export function pasteGitExcludePattern(agent: AgentKind = "claude"): string {
  return imagePasteAdapter(agent).gitExcludePattern;
}

export function pasteInputText(agent: AgentKind, imagePath: string): string {
  return imagePasteAdapter(agent).inputText(imagePath);
}

/** Stable, unique-ish filename for a pasted image (caller passes a timestamp). */
export function pasteFilename(stamp: number | string, ext: string): string {
  return `paste-${stamp}.${ext}`;
}
