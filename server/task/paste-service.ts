import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Runner } from "../fleet/runner.js";
import { getOwnedTask } from "../core/ownership.js";
import { asAgentKind } from "../session/agent.js";
import { pasteText } from "../session/tmux.js";
import {
  extForMime,
  pasteFilename,
  pasteGitExcludePattern,
  pasteInputText,
  pastedDest,
  pasteTargetBase,
} from "./paste.js";

type DB = Database.Database;

export type PasteImageResult =
  | { ok: true }
  | { ok: false; error: "badType" | "empty" | "notFound" | "noTarget" | "writeFailed"; message?: string };

export async function pasteImageIntoOwnedTask(
  db: DB,
  runner: Runner,
  ns: string,
  taskId: number,
  mime: string | undefined,
  bytes: Buffer,
): Promise<PasteImageResult> {
  if (runner.kind !== "local") {
    return { ok: false, error: "writeFailed", message: "Image paste must be handled by the node that owns the task" };
  }
  const ext = extForMime(mime);
  if (!ext) return { ok: false, error: "badType" };
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, error: "empty" };
  const task = getOwnedTask(db, taskId);
  if (!task) return { ok: false, error: "notFound" };
  const base = pasteTargetBase(task);
  if (!base) return { ok: false, error: "noTarget" };

  const agent = asAgentKind(task.agent);
  const dest = pastedDest(base, pasteFilename(Date.now(), ext), agent);
  const tmp = path.join(os.tmpdir(), `tdsp-paste-${ns}-${task.id}-${path.basename(dest)}`);
  try {
    fs.writeFileSync(tmp, bytes);
    await runner.putFile(tmp, dest);
  } catch (error: any) {
    return { ok: false, error: "writeFailed", message: String(error?.message || error) };
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  const excludePattern = pasteGitExcludePattern(agent);
  await runner.exec("sh", ["-c",
    `cd ${JSON.stringify(base)} && p=$(git rev-parse --git-path info/exclude 2>/dev/null) && [ -n "$p" ] && ` +
      `{ grep -qxF ${JSON.stringify(excludePattern)} "$p" 2>/dev/null || printf '%s\\n' ${JSON.stringify(excludePattern)} >> "$p"; }`,
  ]).catch(() => {});
  if (task.session) await pasteText(runner, task.session, pasteInputText(agent, dest)).catch(() => {});
  return { ok: true };
}
