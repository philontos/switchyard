// Read a task's agent conversation as a normalized, append-only entry stream — the
// data behind the mobile "阅读 / Reading" view. The supported transcript parsers persist their
// session to disk as JSONL; we locate that file, tail it from a byte cursor, and map
// each line to agent-agnostic Entry objects the client renders as a chat.
//
//   Claude:  ~/.claude/projects/<escaped-cwd>/<session>.jsonl   (session id captured
//            by the SessionStart hook → tasks.claude_session; cwd = the worktree)
//   Codex:   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl  (no hook, so we
//            locate it the way `codex resume --last` does: newest rollout whose
//            session_meta.cwd == the worktree)
//   Kimi:    launched and live in the terminal, but not parsed into Reading yet.
//
// All file access is performed by the task's owning node. A controller asks that
// node for higher-level task operations; it never locates or tails the node's
// transcript files over SSH. Parsing is stateless per line, so tailing remains a
// pure append with a simple byte cursor.
import os from "node:os";
import type { Runner } from "../fleet/runner.js";
import { asAgentKind, type AgentKind } from "./agent.js";
import type { Task } from "../core/db.js";

// One rendered unit of the conversation. `tool_call`/`tool_result` share an `id` so the
// client can fold a result into its call; everything else carries display `text`.
export type Entry =
  | { t: "user"; text: string }
  | { t: "assistant"; text: string }
  | { t: "thinking"; text: string }
  | { t: "tool_call"; id: string; name: string; arg: string; detail: string }
  | { t: "tool_result"; id: string; ok: boolean; output: string };

export interface TranscriptResult {
  agent: AgentKind;
  /** identity of the underlying file (Claude session id / Codex rollout path). When it
   *  changes (e.g. /clear starts a new Claude session), the client drops its cursor. */
  source: string | null;
  entries: Entry[];
  /** byte offset to pass back as `since` on the next poll to get only what's new. */
  cursor: number;
}

const OUT_CAP = 6000;   // truncate a single tool output to keep the payload sane
const IN_CAP = 2000;    // truncate a tool's expanded input detail
const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…（已截断）" : s);
const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

// Best one-liner for a tool call's summary row: the command / file / pattern it acts on.
function toolArg(input: unknown): string {
  const o = typeof input === "string" ? tryParse(input) : input;
  if (o && typeof o === "object") {
    const rec = o as Record<string, unknown>;
    for (const k of ["command", "cmd", "file_path", "path", "pattern", "url", "query", "description"]) {
      if (typeof rec[k] === "string") return oneLine(rec[k] as string, 140);
    }
    for (const k of Object.keys(rec)) if (typeof rec[k] === "string") return oneLine(rec[k] as string, 140);
    return "";
  }
  return typeof input === "string" ? oneLine(input, 140) : "";
}
function toolDetail(input: unknown): string {
  if (input == null) return "";
  const s = typeof input === "string" ? (tryParse(input) ? JSON.stringify(JSON.parse(input as string), null, 2) : input) : JSON.stringify(input, null, 2);
  return cap(s, IN_CAP);
}

// Claude tool_result.content is a string or an array of {type,text|...} blocks.
function claudeContentStr(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : (x?.type === "text" ? x.text : x?.type === "image" ? "[image]" : ""))).join("");
  return c == null ? "" : JSON.stringify(c);
}

// ---- per-agent line → entries (stateless; unknown/meta lines yield nothing) ----

// Skip Claude's synthetic user turns: slash-command wrappers and injected caveats that
// aren't things the person typed. Real prompts and interruption notes pass through.
function isClaudeNoise(text: string): boolean {
  const s = text.trimStart();
  return s.startsWith("<command-") || s.startsWith("<local-command") || s.startsWith("Caveat:");
}

export function parseClaudeLine(o: any): Entry[] {
  if (!o || o.isSidechain) return [];   // drop sub-agent (Task tool) sidechains — noise in a read view
  const t = o.type;
  if (t !== "user" && t !== "assistant") return [];
  const c = o.message?.content;
  const out: Entry[] = [];
  if (typeof c === "string") {
    if (c.trim() && !isClaudeNoise(c)) out.push({ t: "user", text: c });
    return out;
  }
  if (!Array.isArray(c)) return out;
  for (const b of c) {
    if (b?.type === "text") {
      if (b.text?.trim() && !(t === "user" && isClaudeNoise(b.text))) out.push({ t: t === "user" ? "user" : "assistant", text: b.text });
    } else if (b?.type === "thinking") {
      if (b.thinking?.trim()) out.push({ t: "thinking", text: b.thinking });
    } else if (b?.type === "tool_use") {
      out.push({ t: "tool_call", id: String(b.id ?? ""), name: String(b.name ?? "tool"), arg: toolArg(b.input), detail: toolDetail(b.input) });
    } else if (b?.type === "tool_result") {
      out.push({ t: "tool_result", id: String(b.tool_use_id ?? ""), ok: !b.is_error, output: cap(claudeContentStr(b.content), OUT_CAP) });
    }
  }
  return out;
}

export function parseCodexLine(o: any): Entry[] {
  // Only response_item lines carry the canonical transcript; event_msg mirrors them and
  // would double every message, so it's skipped.
  if (!o || o.type !== "response_item") return [];
  const p = o.payload ?? {};
  const pt = p.type;
  if (pt === "message") {
    const role = p.role;
    if (role !== "user" && role !== "assistant") return [];   // developer/system context → skip
    const text = (Array.isArray(p.content) ? p.content : []).filter((x: any) => /text/.test(x?.type)).map((x: any) => x.text ?? "").join("");
    if (!text.trim()) return [];
    if (role === "user" && text.trimStart().startsWith("<")) return [];   // <environment_context> etc.
    return [{ t: role, text }];
  }
  if (pt === "reasoning") {
    const text = (Array.isArray(p.summary) ? p.summary : []).map((s: any) => s?.text ?? "").join("\n");
    return text.trim() ? [{ t: "thinking", text }] : [];   // usually empty — Codex encrypts its reasoning
  }
  if (pt === "function_call" || pt === "custom_tool_call") {
    const input = pt === "function_call" ? p.arguments : p.input;
    return [{ t: "tool_call", id: String(p.call_id ?? p.id ?? ""), name: String(p.name ?? "tool"), arg: toolArg(input), detail: toolDetail(input) }];
  }
  if (pt === "function_call_output" || pt === "custom_tool_call_output") {
    return [{ t: "tool_result", id: String(p.call_id ?? ""), ok: true, output: cap(String(p.output ?? ""), OUT_CAP) }];
  }
  if (pt === "web_search_call") {
    return [{ t: "tool_call", id: String(p.id ?? ""), name: "web_search", arg: oneLine(JSON.stringify(p.action ?? {}), 140), detail: toolDetail(p.action) }];
  }
  return [];
}

// ---- file location ----

const escapeClaudeCwd = (cwd: string) => cwd.replace(/[/.]/g, "-");

// Locate a task's Codex rollout: the newest rollout whose session_meta.cwd is the
// worktree. Cached per task once found (the file only grows). One shell round-trip.
const codexPathCache = new Map<number, string>();
async function locateCodex(runner: Runner, home: string, cwd: string, taskId: number): Promise<string | null> {
  const cached = codexPathCache.get(taskId);
  if (cached && (await runner.exists(cached).catch(() => false))) return cached;
  const dir = `${home}/.codex/sessions`;
  const needle = `"cwd"[[:space:]]*:[[:space:]]*${ere(JSON.stringify(cwd))}`;
  // newest-first (the ISO date lives in the path), stop at the first rollout whose
  // session_meta line names this worktree. Use an ERE instead of a literal
  // `"cwd":"..."` substring because Codex JSONL formatting can include spaces after
  // colons; missing that file leaves mobile stuck in the live xterm instead of the
  // native-scrolling reading view.
  const cmd = `find ${sh(dir)} -name 'rollout-*.jsonl' 2>/dev/null | sort -r | while IFS= read -r f; do `
    + `head -c 4096 "$f" | grep -Eq ${sh(needle)} && { printf '%s' "$f"; break; }; done`;
  const found = (await runner.exec("sh", ["-c", cmd]).catch(() => "")).trim();
  if (found) codexPathCache.set(taskId, found);
  return found || null;
}
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ere = (s: string) => s.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");

// ---- tail ----

// Read a file's bytes from `since` to EOF, keeping only complete lines. Returns the new
// text and the advanced byte cursor; resets to 0 if the file shrank (rotated).
async function tailFrom(runner: Runner, file: string, since: number): Promise<{ text: string; cursor: number } | null> {
  const sizeOut = await runner.exec("wc", ["-c", file]).catch(() => null);
  if (sizeOut == null) return null;   // missing / unreadable
  const size = parseInt(sizeOut.trim().split(/\s+/)[0] || "0", 10) || 0;
  let from = since > size ? 0 : since;   // shrank/rotated → reload from the top
  if (from >= size) return { text: "", cursor: size };
  const raw = await runner.exec("tail", ["-c", "+" + (from + 1), file]).catch(() => "");
  const lastNl = raw.lastIndexOf("\n");
  if (lastNl < 0) return { text: "", cursor: from };   // no complete line yet
  const consumed = raw.slice(0, lastNl + 1);
  return { text: consumed, cursor: from + Buffer.byteLength(consumed, "utf8") };
}

/**
 * Read a task's conversation incrementally. `since` is the byte cursor from the previous
 * call (0 / omitted for a fresh load); `knownSource` is the client's last source id — if
 * it no longer matches (a new session / rollout), we reload from the top so the client
 * doesn't stitch two conversations together.
 */
export async function readTranscript(
  runner: Runner,
  task: Task,
  since = 0,
  knownSource: string | null = null,
): Promise<TranscriptResult> {
  if (runner.kind !== "local") throw new Error("Transcript must be read by the node that owns the task");
  const agent = asAgentKind(task.agent);
  const cwd = task.worktree_path;
  if (!cwd) return { agent, source: null, entries: [], cursor: 0 };
  const home = os.homedir();
  if (agent === "kimi") return { agent, source: null, entries: [], cursor: 0 };

  let file: string | null = null;
  let source: string | null = null;
  if (agent === "codex") {
    file = await locateCodex(runner, home, cwd, task.id);
    source = file;
  } else {
    const sid = task.claude_session;
    if (sid) { file = `${home}/.claude/projects/${escapeClaudeCwd(cwd)}/${sid}.jsonl`; source = sid; }
  }
  if (!file || !source) return { agent, source: null, entries: [], cursor: 0 };

  const from = knownSource && knownSource !== source ? 0 : since;   // source changed → reload
  const tail = await tailFrom(runner, file, from);
  if (!tail) return { agent, source, entries: [], cursor: from };

  const parse = agent === "codex" ? parseCodexLine : parseClaudeLine;
  const entries: Entry[] = [];
  for (const line of tail.text.split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    entries.push(...parse(o));
  }
  return { agent, source, entries, cursor: tail.cursor };
}
