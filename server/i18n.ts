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
    "notFound": "not found",
    "task.fieldsRequired": "repo_id, base_branch, title required",
    "task.worktreeExists": "worktree still exists, remove it first",
    "session.invalid": "invalid session",
    "session.attachFailed": "cannot connect to session {session}: {error}",
    "host.offline": "machine is offline",
    "task.remoteSoon": "remote dispatch isn't supported yet (coming soon)",
  },
  zh: {
    "repo.fieldsRequired": "名称和 git url 必填",
    "repo.notFound": "未找到仓库",
    "repo.status": "仓库状态为 {status}",
    "notFound": "未找到",
    "task.fieldsRequired": "仓库、基分支、标题必填",
    "task.worktreeExists": "worktree 仍存在，请先删除 worktree",
    "session.invalid": "会话名非法",
    "session.attachFailed": "无法连接会话 {session}: {error}",
    "host.offline": "机器离线",
    "task.remoteSoon": "远程派发暂未支持（即将上线）",
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
