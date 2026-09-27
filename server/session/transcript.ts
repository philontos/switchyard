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
//   Kimi:    ~/.kimi-code/session_index.jsonl maps the worktree to a session dir;
//            agents/main/wire.jsonl is its durable conversation event stream.
//
// All file access is performed by the task's owning node. A controller asks that
// node for higher-level task operations; it never locates or tails the node's
// transcript files over SSH. Parsing is stateless per line, so tailing remains a
// pure append with a simple byte cursor.
import os from "node:os";
import path from "node:path";
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
  /** Opaque identity of the underlying session. It deliberately contains no
   *  owner-local path; when it changes, the client drops its cursor. */
  source: string | null;
  entries: Entry[];
  /** byte offset to pass back as `since` on the next poll to get only what's new. */
  cursor: number;
  /** More complete lines are ready. The client may fetch the next page immediately. */
  hasMore?: boolean;
  /** Proof that Codex entries came from semantic user_message events. */
  mode?: "codex-user-message-v1";
}

export const TRANSCRIPT_CAPABILITY = "transcript-v1";
export interface TranscriptReadRequest {
  taskId: number;
  since: number;
  source: string | null;
  userOnly?: boolean;
}
export type TranscriptCommandResult =
  | { ok: true; transcript: TranscriptResult }
  | { ok: false; error: "notFound" | "invalidRequest" | "readFailed"; message: string };

const SOURCE_CAP = 4096;
const PAGE_CAP = 4 * 1024 * 1024;
const OUT_CAP = 6000;   // truncate a single tool output to keep the payload sane
const IN_CAP = 2000;    // truncate a tool's expanded input detail
const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…（已截断）" : s);
const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

export function isTranscriptReadRequest(value: unknown): value is TranscriptReadRequest {
  const request = value as Partial<TranscriptReadRequest> | null;
  return !!request
    && Number.isSafeInteger(request.taskId) && Number(request.taskId) > 0
    && Number.isSafeInteger(request.since) && Number(request.since) >= 0
    && (request.source === null || (typeof request.source === "string" && request.source.length <= SOURCE_CAP))
    && (request.userOnly === undefined || typeof request.userOnly === "boolean");
}

function isEntry(value: unknown): value is Entry {
  const entry = value as Record<string, unknown> | null;
  if (!entry || typeof entry.t !== "string") return false;
  if (entry.t === "user" || entry.t === "assistant" || entry.t === "thinking") {
    return typeof entry.text === "string";
  }
  if (entry.t === "tool_call") {
    return typeof entry.id === "string"
      && typeof entry.name === "string"
      && typeof entry.arg === "string"
      && typeof entry.detail === "string";
  }
  if (entry.t === "tool_result") {
    return typeof entry.id === "string"
      && typeof entry.ok === "boolean"
      && typeof entry.output === "string";
  }
  return false;
}

export function isTranscriptResult(value: unknown): value is TranscriptResult {
  const result = value as Partial<TranscriptResult> | null;
  return !!result
    && (result.agent === "claude" || result.agent === "codex" || result.agent === "kimi")
    && (result.source === null || (typeof result.source === "string" && result.source.length <= SOURCE_CAP))
    && Number.isSafeInteger(result.cursor) && Number(result.cursor) >= 0
    && Array.isArray(result.entries) && result.entries.every(isEntry)
    && (result.hasMore === undefined || typeof result.hasMore === "boolean")
    && (result.mode === undefined || result.mode === "codex-user-message-v1");
}

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

// Kimi ContentPart arrays use text/think plus media containers. Read mode does
// not render binary media inline, but retaining a marker keeps an image-only
// prompt or tool result visible in the conversation.
function kimiContentStr(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return c == null ? "" : JSON.stringify(c);
  return c.map((x) => {
    if (typeof x === "string") return x;
    if (x?.type === "text" && typeof x.text === "string") return x.text;
    if (x?.type === "think" && typeof x.think === "string") return x.think;
    if (x?.imageUrl || x?.image_url || x?.type === "image") return "[image]";
    if (x?.audioUrl || x?.audio_url || x?.type === "audio") return "[audio]";
    return "";
  }).join("");
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
    if (c.trim() && !(t === "user" && isClaudeNoise(c))) {
      out.push({ t: t === "user" ? "user" : "assistant", text: c });
    }
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

export function parseKimiLine(o: any): Entry[] {
  if (!o || typeof o !== "object") return [];

  // turn.prompt/turn.steer are followed by this canonical context message, so
  // parsing both would duplicate every user turn. Injections (permission mode,
  // todo reminders, compaction summaries, etc.) are agent context, not things
  // the person typed, and stay out of the reading view.
  if (o.type === "context.append_message") {
    const m = o.message ?? {};
    if (m.role !== "user" || m.origin?.kind !== "user") return [];
    const text = kimiContentStr(m.content);
    return text.trim() ? [{ t: "user", text }] : [];
  }

  if (o.type !== "context.append_loop_event") return [];
  const e = o.event ?? {};
  if (e.type === "content.part") {
    const p = e.part ?? {};
    if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
      return [{ t: "assistant", text: p.text }];
    }
    if ((p.type === "think" || p.type === "thinking")) {
      const text = typeof p.think === "string" ? p.think : typeof p.thinking === "string" ? p.thinking : "";
      return text.trim() ? [{ t: "thinking", text }] : [];
    }
    return [];
  }
  if (e.type === "tool.call") {
    return [{
      t: "tool_call",
      id: String(e.toolCallId ?? e.id ?? ""),
      name: String(e.name ?? "tool"),
      arg: toolArg(e.args),
      detail: toolDetail(e.args),
    }];
  }
  if (e.type === "tool.result") {
    const result = e.result ?? {};
    const output = result.output ?? result.content ?? "";
    return [{
      t: "tool_result",
      id: String(e.toolCallId ?? e.id ?? ""),
      ok: !result.isError,
      output: cap(kimiContentStr(output), OUT_CAP),
    }];
  }
  return [];
}

// The event stream is the strongest source for identifying what the person
// actually submitted. Unlike response_item(role=user), user_message events do
// not contain injected <environment_context> or other synthetic context. Keep
// this separate from parseCodexLine: the normal transcript uses response_item as
// its canonical all-role stream and would otherwise render every prompt twice.
export function parseCodexUserLine(o: any): Entry[] {
  if (!o || o.type !== "event_msg" || o.payload?.type !== "user_message") return [];
  const text = typeof o.payload.message === "string" ? o.payload.message : "";
  return text.trim() ? [{ t: "user", text }] : [];
}

// ---- file location ----

const escapeClaudeCwd = (cwd: string) => cwd.replace(/[/.]/g, "-");

// Locate a task's Codex rollout: the newest rollout whose session_meta.cwd is the
// worktree. Normal transcript reads reuse the cache; semantic live-turn checks can
// refresh it to notice a new rollout after /new or a process restart.
const codexPathCache = new Map<number, string>();
async function locateCodex(
  runner: Runner,
  home: string,
  cwd: string,
  taskId: number,
  refresh = false,
): Promise<string | null> {
  const cached = codexPathCache.get(taskId);
  if (!refresh && cached && (await runner.exists(cached).catch(() => false))) return cached;
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

interface KimiSessionIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
  order: number;
}

// Kimi's index is append-only: a later record replaces/deletes an earlier record
// with the same session id. A worktree can have multiple sessions after /new or
// /sessions, so prefer the state.json with the newest activity timestamp, using
// index order as a deterministic fallback. Re-evaluating the small index on each
// poll lets Read follow a session switch and causes the source id to reset cleanly.
async function locateKimi(runner: Runner, home: string, cwd: string): Promise<{ file: string; source: string } | null> {
  const kimiHome = process.env.KIMI_CODE_HOME || path.join(home, ".kimi-code");
  const sessionsRoot = path.resolve(kimiHome, "sessions");
  const raw = await runner.readText(path.join(kimiHome, "session_index.jsonl")).catch(() => null);
  if (!raw) return null;

  const byId = new Map<string, KimiSessionIndexEntry>();
  let order = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec.sessionId !== "string") continue;
    if (rec.deleted === true) { byId.delete(rec.sessionId); continue; }
    if (typeof rec.sessionDir !== "string" || typeof rec.workDir !== "string") continue;
    byId.set(rec.sessionId, { ...rec, order: order++ });
  }

  let best: { file: string; activity: number; order: number } | null = null;
  for (const rec of byId.values()) {
    if (path.resolve(rec.workDir) !== path.resolve(cwd)) continue;
    const sessionDir = path.resolve(rec.sessionDir);
    const rel = path.relative(sessionsRoot, sessionDir);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || path.basename(sessionDir) !== rec.sessionId) continue;
    const file = path.join(sessionDir, "agents", "main", "wire.jsonl");
    if (!(await runner.exists(file).catch(() => false))) continue;

    let activity = 0;
    const state = await runner.readText(path.join(sessionDir, "state.json")).catch(() => null);
    if (state) {
      try {
        const parsed = JSON.parse(state);
        const recordedCwd = typeof parsed?.workDir === "string" ? path.resolve(parsed.workDir) : null;
        if (recordedCwd && recordedCwd !== path.resolve(cwd)) continue;
        activity = Date.parse(parsed?.updatedAt || parsed?.createdAt || "") || 0;
      } catch {}
    }
    if (!best || activity > best.activity || (activity === best.activity && rec.order > best.order)) {
      best = { file, activity, order: rec.order };
    }
  }
  if (!best) return null;
  const sessionId = path.basename(path.dirname(path.dirname(path.dirname(best.file))));
  return { file: best.file, source: `kimi:${sessionId}` };
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
  options: { userOnly?: boolean } = {},
): Promise<TranscriptResult> {
  if (runner.kind !== "local") throw new Error("Transcript must be read by the node that owns the task");
  const agent = asAgentKind(task.agent);
  const userOnly = agent === "codex" && options.userOnly === true;
  const mode = userOnly ? "codex-user-message-v1" as const : undefined;
  const cwd = task.worktree_path;
  if (!cwd) return { agent, source: null, entries: [], cursor: 0, hasMore: false, mode };
  const home = os.homedir();

  let file: string | null = null;
  let source: string | null = null;
  if (agent === "codex") {
    // Semantic marker reads refresh discovery so /new or a restarted Codex
    // process cannot leave the client attached to the previous rollout.
    file = await locateCodex(runner, home, cwd, task.id, userOnly);
    source = file ? `codex:${path.basename(file)}` : null;
  } else if (agent === "kimi") {
    const located = await locateKimi(runner, home, cwd);
    file = located?.file ?? null;
    source = located?.source ?? null;
  } else {
    const sid = task.claude_session;
    if (sid) {
      file = `${home}/.claude/projects/${escapeClaudeCwd(cwd)}/${sid}.jsonl`;
      source = `claude:${sid}`;
    }
  }
  if (!file || !source) return { agent, source: null, entries: [], cursor: 0, hasMore: false, mode };

  const from = knownSource && knownSource !== source ? 0 : since;   // source changed → reload
  const tail = await tailFrom(runner, file, from);
  if (!tail) return { agent, source, entries: [], cursor: from, hasMore: false, mode };

  const parse = agent === "codex"
    ? (userOnly ? parseCodexUserLine : parseCodexLine)
    : agent === "kimi" ? parseKimiLine : parseClaudeLine;
  const entries: Entry[] = [];
  let cursor = from;
  let payloadBytes = 0;
  for (const line of tail.text.split("\n")) {
    if (!line) {
      if (cursor < tail.cursor) cursor += 1;
      continue;
    }
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    let o: any;
    try { o = JSON.parse(line); } catch {
      cursor += lineBytes;
      continue;
    }
    const next = parse(o);
    const nextBytes = Buffer.byteLength(JSON.stringify(next), "utf8");
    if (entries.length && payloadBytes + nextBytes > PAGE_CAP) break;
    entries.push(...next);
    payloadBytes += nextBytes;
    cursor += lineBytes;
  }
  cursor = Math.min(cursor, tail.cursor);
  return { agent, source, entries, cursor, hasMore: cursor < tail.cursor, mode };
}
