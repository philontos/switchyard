// Server-side i18n — the SINGLE SOURCE OF TRUTH for every fixed, user-facing
// message the API returns. The web UI's own strings live separately in
// web/i18n.js; this file only covers messages produced by the server.
//
// HOW TO ADD A MESSAGE
//   1. Add the key to BOTH `en` and `zh` below (keep the key sets identical —
//      the dev-time check at the bottom warns if they drift).
//   2. Use `{name}` placeholders for interpolated values.
//   3. In a route, replace the literal with `tr(langFromReq(req), "your.key", { ... })`.
//
// WHAT DOES NOT BELONG HERE
//   Raw output from external tools (git / glab / node-pty). Those errors are
//   passed through verbatim via `String(e.message || e)` — they are dynamic and
//   not ours to translate.

import type { IncomingMessage } from "node:http";

export type Lang = "en" | "zh";
const DEFAULT_LANG: Lang = "en";

const messages: Record<Lang, Record<string, string>> = {
  en: {
    "repo.fieldsRequired": "name and git_url required",
    "repo.notFound": "repo not found",
    "repo.status": "repo {status}",
    "repo.hasLiveTasks": "repository still has {count} task(s) in progress; handle them first or force delete",
    "notFound": "not found",
    "task.fieldsRequired": "repo_id, base_branch, title required",
    "task.titleRequired": "title required",
    "task.worktreeExists": "worktree still exists, remove it first",
    "task.notResumable": "task cannot be resumed (no session or worktree on record)",
    "task.worktreeGone": "worktree no longer exists on disk; rebuild it instead",
    "task.localDefaultTitle": "Local task #{id}",
    "task.cwdMissing": "directory does not exist: {cwd}",
    "session.invalid": "invalid session",
    "session.attachFailed": "cannot connect to session {session}: {error}",
    "session.orphanRefused": "session {name} is not tracked by this Switchyard instance (it may belong to another instance sharing this machine); pass force to kill it anyway",
    "host.offline": "machine is offline",
    "host.nodeUpdateRequired": "this node is running an older tdsp; open the machine's ⚙ menu, click \"Update code\", then retry",
    "skill.missing": "skill(s) not found: {keys}",
    "plugin.idRequired": "pluginId required",
    "paste.badType": "unsupported image type",
    "paste.empty": "empty image data",
    "paste.noTarget": "this task has no working directory for pasted images",
  },
  zh: {
    "repo.fieldsRequired": "名称和 git url 必填",
    "repo.notFound": "未找到仓库",
    "repo.status": "仓库状态为 {status}",
    "repo.hasLiveTasks": "该仓库下还有 {count} 个进行中的任务，请先处理或强制删除",
    "notFound": "未找到",
    "task.fieldsRequired": "仓库、基分支、标题必填",
    "task.titleRequired": "标题必填",
    "task.worktreeExists": "worktree 仍存在，请先删除 worktree",
    "task.notResumable": "该任务无法恢复（没有会话或 worktree 记录）",
    "task.worktreeGone": "worktree 已不在磁盘上，请改用重建",
    "task.localDefaultTitle": "本地任务 #{id}",
    "task.cwdMissing": "目录不存在：{cwd}",
    "session.invalid": "会话名非法",
    "session.attachFailed": "无法连接会话 {session}: {error}",
    "session.orphanRefused": "会话 {name} 不属于当前 Switchyard 实例（可能属于共用本机的另一个实例）；如确需结束请传 force",
    "host.offline": "机器离线",
    "host.nodeUpdateRequired": "该节点的 tdsp 版本较旧；请打开机器的 ⚙ 菜单，点击“更新代码”后重试",
    "skill.missing": "未找到 skill：{keys}",
    "plugin.idRequired": "缺少 pluginId",
    "paste.badType": "不支持的图片类型",
    "paste.empty": "空图片数据",
    "paste.noTarget": "该任务没有可存放粘贴图片的工作目录",
  },
};

/** Resolve a value into a {placeholder}-interpolated, localized string. */
export function tr(lang: Lang, key: string, params?: Record<string, unknown>): string {
  const s = messages[lang]?.[key] ?? messages[DEFAULT_LANG][key] ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
}

/** Pick a locale from a request: explicit `X-Lang` header wins, then Accept-Language. */
export function langFromReq(req: IncomingMessage): Lang {
  const header = (req.headers["x-lang"] || "").toString().toLowerCase();
  if (header === "zh" || header === "en") return header;
  const accept = (req.headers["accept-language"] || "").toString().toLowerCase();
  if (accept.startsWith("zh")) return "zh";
  return DEFAULT_LANG;
}

/** Pick a locale from a URL query (used by the WebSocket upgrade, which has no JSON body). */
export function langFromQuery(value: string | null): Lang {
  return value === "zh" || value === "en" ? value : DEFAULT_LANG;
}

// Dev-time guard: keep the two locales in lockstep so nothing ships half-translated.
{
  const en = Object.keys(messages.en);
  const zh = Object.keys(messages.zh);
  const onlyEn = en.filter((k) => !(k in messages.zh));
  const onlyZh = zh.filter((k) => !(k in messages.en));
  if (onlyEn.length || onlyZh.length) {
    console.warn("[i18n] server message key mismatch", { onlyEn, onlyZh });
  }
}
