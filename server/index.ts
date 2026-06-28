import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { spawnPty } from "./pty.js";
import { attachCommand } from "./attach.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, Repo, Task, Host } from "./db.js";
import { renameTask } from "./tasks.js";
import {
  initMirror, fetchMirror, listBranches, addWorktreeFromBranch, removeWorktree,
  mirrorPath,
} from "./git.js";
import { scanSkills, resolveSkills, defaultSources } from "./skills.js";
import { extForMime, pasteTargetBase, pastedDest, pasteFilename } from "./paste.js";
import { listAvailable, installPlugin } from "./plugins.js";
import { startSession, startShellSession, hasSession, killSession, listSessions, cancelCopyMode, pasteText } from "./tmux.js";
import { syncReposManifest } from "./manifest.js";
import { writeTaskManifest, removeTaskManifest, readTaskManifests, adoptTaskManifests } from "./taskmanifest.js";
import { repairWorktrees } from "./migrate.js";
import { localRunner, runnerFor, sshForwardArgs, SSH_BASE_ARGS, type Runner } from "./runner.js";
import { aggregateNodes } from "./cli.js";
import { fleetTargets, tasksForHost, type FleetTarget } from "./fleet.js";
import { bootstrapMachine } from "./bootstrap.js";
import net from "node:net";
import { spawn as spawnChild, execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveCwd } from "./local.js";
import { createRepoTask, type RepoTaskEnv } from "./createtask.js";
import { buildRepoTaskEnv } from "./repoenv.js";
import { hookSettingsJson } from "./hooks.js";
import { startLivenessLoop, probeHost } from "./liveness.js";
import { WEB_DIR, DID_MIGRATE, NS, DATA_DIR, ROOT } from "./paths.js";
import { tr, langFromReq, langFromQuery } from "./i18n.js";
import { createPreviewMiddleware, handlePreviewUpgrade, parsePreviewHost, tcpProbe, createForwardRegistry, type PreviewResolution, type ForwardHandle } from "./preview.js";

// ensure child processes (git/tmux/glab/pty) find Homebrew/usr-local binaries
// regardless of how the server was launched (a stripped PATH otherwise breaks
// tmux/pty with "posix_spawnp failed").
for (const p of ["/opt/homebrew/bin", "/usr/local/bin"]) {
  if (!(process.env.PATH || "").split(":").includes(p)) {
    process.env.PATH = `${p}:${process.env.PATH || ""}`;
  }
}
// never let a single bad pty/connection take down the whole server
process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

// resolve tmux to an absolute path — node-pty's spawn-helper does not honor a
// mutated PATH, so a bare "tmux" fails with posix_spawnp on stripped envs.
const TMUX_BIN =
  ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => fs.existsSync(p)) ||
  "tmux";

// node-pty's spawn-helper ignores a mutated PATH, so resolve ssh/mosh to
// absolute paths the same way (used for remote machine terminals).
function resolveBin(name: string, candidates: string[]) {
  return candidates.find((p) => fs.existsSync(p)) || name;
}
const SSH_BIN = resolveBin("ssh", ["/usr/bin/ssh", "/opt/homebrew/bin/ssh"]);
const MOSH_BIN = resolveBin("mosh", ["/opt/homebrew/bin/mosh", "/usr/local/bin/mosh", "/usr/bin/mosh"]);

const app = express();
app.use(express.json());

const getRepo = db.prepare("SELECT * FROM repos WHERE id = ?");
const getTask = db.prepare("SELECT * FROM tasks WHERE id = ?");
const getHost = db.prepare("SELECT * FROM hosts WHERE id = ?");

// the Runner for a task's machine — local or remote(ssh/mosh)
function taskRunner(task: Task) {
  const host = taskHost(task);
  return host ? runnerFor(host) : localRunner;
}

// the machine a task lives on — for attach + the offline write-guard. Shell
// tasks (kind='local') carry host_id directly; repo tasks resolve via their repo.
function taskHost(task: Task): Host | undefined {
  if (task.host_id != null) return getHost.get(task.host_id) as Host | undefined;
  const repo = getRepo.get(task.repo_id) as Repo | undefined;
  return repo ? (getHost.get(repo.host_id) as Host | undefined) : undefined;
}

// a write that must run ON a machine is refused while that machine is offline
// (the local machine is always reachable). Reads stay allowed.
function offline(host: Host | undefined): boolean {
  return !!host && host.kind !== "local" && host.status !== "online";
}

// Write-convergence: every task mutation funnels through here so the on-disk
// manifest (the durable, edge-resident truth) mirrors the row. We only write the
// manifest for tasks THIS machine owns — a task running on a remote is owned and
// manifested by that machine's own tdsp (once control sinks to the edge), never
// stamped into this controller's data dir.
function syncTaskManifest(id: number) {
  const t = getTask.get(id) as Task | undefined;
  if (!t) return;
  const host = taskHost(t);
  if (!host || host.kind === "local") writeTaskManifest(DATA_DIR, t);
}

// ---------- web preview ----------
// Reach a task's dev server (127.0.0.1:<port> ON its machine). Local tasks the
// frontend hits directly; remote tasks are reverse-proxied through a t<task>-
// <port>.localhost origin (see preview.ts) whose upstream is an ssh -L forward.

// a free loopback port for an ssh -L forward's local end
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); });
  });
}
async function waitListening(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpProbe("127.0.0.1", port, 500)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
// one ssh -N -L forward per (remote host, remote port), riding the shared
// ControlMaster; the registry tears it down after idle.
const forwards = createForwardRegistry(async (target, remotePort): Promise<ForwardHandle> => {
  const localPort = await freePort();
  const child = spawnChild(SSH_BIN, sshForwardArgs(target.target, localPort, remotePort), { stdio: "ignore" });
  child.on("error", () => {});
  if (!(await waitListening(localPort, 5000))) { child.kill(); throw new Error("ssh -L not ready"); }
  return { localPort, close: () => { try { child.kill(); } catch {} } };
});

// A dev server may bind IPv4 (127.0.0.1) or IPv6 (::1) loopback — vite binds ::1
// by default on macOS. Pick whichever family is actually listening (or null).
// Cached briefly so a page load's burst of proxied requests doesn't re-probe.
const lbCache = new Map<number, { host: string; exp: number }>();
async function loopbackHostFor(port: number): Promise<string | null> {
  const c = lbCache.get(port);
  if (c && c.exp > Date.now()) return c.host;
  let host: string | null = null;
  if (await tcpProbe("127.0.0.1", port, 1500)) host = "127.0.0.1";
  else if (await tcpProbe("::1", port, 1500)) host = "::1";
  if (host) lbCache.set(port, { host, exp: Date.now() + 5000 });
  return host;
}

// Resolve a preview to its upstream. Resolves ONLY to a live task's own loopback
// <port> (local) or that port reached via an ssh forward (remote) — never an
// arbitrary host:port, so the proxy can't become an open relay under
// HOST=0.0.0.0. `error` is a human-readable line: previews open in a plain
// browser tab, so on failure the proxy serves this text as the page.
type PreviewTarget =
  | { kind: "local" | "ssh"; host: string; port: number }
  | { error: true; reason: string; status: number };
async function previewTarget(taskId: number, port: number): Promise<PreviewTarget> {
  const task = getTask.get(taskId) as Task | undefined;
  if (!task || task.status === "cleaned") return { error: true, reason: `Preview: task ${taskId} not found or archived.`, status: 404 };
  const host = taskHost(task);
  if (!host || host.kind === "local") {
    const lb = await loopbackHostFor(port); // 127.0.0.1 or ::1, whichever is listening
    if (!lb) return { error: true, reason: `Preview: nothing is listening on port ${port} (dev server not up yet?).`, status: 404 };
    return { kind: "local", host: lb, port };
  }
  if (host.status !== "online") return { error: true, reason: `Preview: machine "${host.name}" is offline.`, status: 502 };
  try {
    const localPort = await forwards.acquire({ id: host.id, target: host.target }, port);
    return { kind: "ssh", host: "127.0.0.1", port: localPort };
  } catch {
    return { error: true, reason: `Preview: couldn't open the ssh forward to "${host.name}".`, status: 502 };
  }
}

// the proxy just needs the upstream host:port (or an error message + status)
async function resolvePreviewUpstream(taskId: number, port: number): Promise<PreviewResolution> {
  const t = await previewTarget(taskId, port);
  return "error" in t ? { error: t.reason, status: t.status } : { host: t.host, port: t.port };
}

// register BEFORE static + the API routes so a preview Host wins on arrival
app.use(createPreviewMiddleware(resolvePreviewUpstream));
app.use(express.static(WEB_DIR));

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
}

// matches dispatcher-owned sessions: tdsp-[<ns>-]<id>[-slug] (+ legacy task-N).
// the optional <ns> segment is this controller's namespace (a-z0-9).
const SESSION_RE = /^(tdsp|task)-([a-z0-9]+-)?\d+(-[a-z0-9-]+)?$/;

// ---------- repos ----------
app.get("/api/repos", (_req, res) => {
  res.json(db.prepare("SELECT id,host_id,name,git_url,default_branch,project_path,status,error,created_at FROM repos ORDER BY id DESC").all());
});

app.post("/api/repos", (req, res) => {
  const { name, git_url, token, default_branch, project_path, host_id } = req.body ?? {};
  const lang = langFromReq(req);
  if (!name || !git_url) return res.status(400).json({ error: tr(lang, "repo.fieldsRequired") });
  // a repo lives ON a machine — default to local, reject offline remotes
  const host = (host_id
    ? getHost.get(host_id)
    : db.prepare("SELECT * FROM hosts WHERE kind='local'").get()) as Host | undefined;
  if (!host) return res.status(404).json({ error: tr(lang, "notFound") });
  if (host.kind !== "local" && host.status !== "online") return res.status(409).json({ error: tr(lang, "host.offline") });
  const runner = runnerFor(host);
  const info = db.prepare(
    "INSERT INTO repos (host_id, name, git_url, token, default_branch, project_path, status) VALUES (?,?,?,?,?,?,?)"
  ).run(host.id, name, git_url, token || null, default_branch || "main", project_path || null, "cloning");
  const id = Number(info.lastInsertRowid);
  const dest = mirrorPath(runner.dataDir, id, name);
  db.prepare("UPDATE repos SET mirror_path = ? WHERE id = ?").run(dest, id);
  syncReposManifest();

  // register in background: init bare repo + validate connectivity (no download)
  (async () => {
    try {
      await initMirror(runner, git_url, token || null, dest);
      db.prepare("UPDATE repos SET status='ready', error=NULL WHERE id=?").run(id);
    } catch (e: any) {
      db.prepare("UPDATE repos SET status='error', error=? WHERE id=?").run(String(e.message || e), id);
    }
  })();

  res.json({ id });
});

app.post("/api/repos/:id/fetch", async (req, res) => {
  const lang = langFromReq(req);
  const repo = getRepo.get(req.params.id) as Repo | undefined;
  if (!repo || !repo.mirror_path) return res.status(404).json({ error: tr(lang, "notFound") });
  const host = getHost.get(repo.host_id) as Host | undefined;
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  try {
    await fetchMirror(runnerFor(host as Host), repo.mirror_path, repo.git_url, repo.token);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/repos/:id/branches", async (req, res) => {
  const repo = getRepo.get(req.params.id) as Repo | undefined;
  const lang = langFromReq(req);
  if (!repo || !repo.mirror_path) return res.status(404).json({ error: tr(lang, "notFound") });
  if (repo.status !== "ready") return res.status(409).json({ error: tr(lang, "repo.status", { status: repo.status }) });
  try {
    res.json(await listBranches(runnerFor(getHost.get(repo.host_id) as Host), repo.mirror_path));
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Delete a repo and everything bound to it — so the per-machine task view never
// strands an invisible orphan. Live tasks (status != cleaned) block a plain
// delete; ?force=1 tears them down too. Archived tasks (cleaned, worktree kept
// or not) are always cleaned up with the repo — no unknown worktree left behind.
app.delete("/api/repos/:id", async (req, res) => {
  const lang = langFromReq(req);
  const repo = getRepo.get(req.params.id) as Repo | undefined;
  if (!repo) return res.status(404).json({ error: tr(lang, "notFound") });
  const host = getHost.get(repo.host_id) as Host | undefined;
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const runner = runnerFor(host as Host);
  const force = req.query.force === "1" || req.query.force === "true";

  const tasks = db.prepare("SELECT * FROM tasks WHERE repo_id=?").all(repo.id) as Task[];
  const live = tasks.filter((t) => t.status !== "cleaned");
  if (live.length && !force) {
    return res.status(409).json({ error: tr(lang, "repo.hasLiveTasks", { count: live.length }), liveCount: live.length });
  }

  // tear down every bound task: kill session + remove worktree. The machine is
  // online (guarded above), so removal should succeed — if a worktree can't be
  // removed, abort (500) rather than silently leave it behind; nothing is
  // deleted yet, so the operation is safely retryable.
  for (const t of tasks) {
    await killSession(runner, t.session).catch(() => {});
    if (t.worktree_path && repo.mirror_path && (await runner.exists(t.worktree_path).catch(() => false))) {
      try {
        await removeWorktree(runner, repo.mirror_path, t.worktree_path, t.work_branch);
      } catch (e: any) {
        return res.status(500).json({ error: String(e.message || e) });
      }
    }
  }
  db.prepare("DELETE FROM tasks WHERE repo_id=?").run(repo.id);
  if (repo.mirror_path) await runner.rmrf(repo.mirror_path).catch(() => {});
  db.prepare("DELETE FROM repos WHERE id=?").run(repo.id);
  syncReposManifest();
  res.json({ ok: true });
});

// ---------- tasks ----------
app.get("/api/tasks", async (_req, res) => {
  const tasks = db.prepare("SELECT * FROM tasks ORDER BY id DESC").all() as Task[];
  const withLive = await Promise.all(
    tasks.map(async (t) => {
      const runner = taskRunner(t);
      const hasWt = !!t.worktree_path && (await runner.exists(t.worktree_path).catch(() => false));
      // Claude session id: the SessionStart hook writes it to <wt>/.claude/session-id;
      // read it back the same way the yellow light reads .claude/waiting, and persist
      // it so the value survives once the worktree is gone (e.g. archived). It only
      // changes on /clear (a fresh conversation), so refreshing each poll keeps it
      // accurate; we fall back to the stored value when the worktree isn't there.
      let claudeSession = t.claude_session ?? null;
      if (hasWt && t.status !== "cleaned") {
        const sid = (await runner.readText(path.join(t.worktree_path, ".claude/session-id")).catch(() => null))?.trim();
        if (sid && sid !== claudeSession) {
          db.prepare("UPDATE tasks SET claude_session=? WHERE id=?").run(sid, t.id);
          claudeSession = sid;
          syncTaskManifest(t.id);
        }
      }
      return {
        ...t,
        claude_session: claudeSession,
        alive: t.status === "cleaned" ? false : await hasSession(runner, t.session).catch(() => false),
        hasWorktree: hasWt,
        // yellow light: the session's hook touches <wt>/.claude/waiting when it
        // blocks on a permission prompt; runner.exists reads it back the same way
        // on the local box (fs) and on a remote (ssh test -e). No worktree → never.
        waiting: t.status !== "cleaned" && hasWt
          && (await runner.exists(path.join(t.worktree_path, ".claude/waiting")).catch(() => false)),
      };
    })
  );
  res.json(withLive);
});

// Bind createRepoTask's seams to a machine's Runner (shared builder in repoenv.ts).
// The HTTP route writes the manifest through the ownership-gated syncTaskManifest,
// unchanged; the `tdsp create` verb passes a local writer instead.
function repoTaskEnvFor(runner: Runner): RepoTaskEnv {
  return buildRepoTaskEnv({ db, ns: NS, runner, writeManifest: (tid) => syncTaskManifest(tid) });
}

app.post("/api/tasks", async (req, res) => {
  const { repo_id, base_branch, title, prompt } = req.body ?? {};
  const lang = langFromReq(req);
  if (!repo_id || !base_branch || !title) {
    return res.status(400).json({ error: tr(lang, "task.fieldsRequired") });
  }
  const repo = getRepo.get(repo_id) as Repo | undefined;
  if (!repo || !repo.mirror_path) return res.status(404).json({ error: tr(lang, "repo.notFound") });
  if (repo.status !== "ready") return res.status(409).json({ error: tr(lang, "repo.status", { status: repo.status }) });
  const host = getHost.get(repo.host_id) as Host | undefined;
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const extraSkills: string[] = Array.isArray(req.body?.extra_skills) ? req.body.extra_skills.map(String) : [];

  // SINK: a bootstrapped remote owns its own tasks — hand the spec to its tdsp and
  // let IT create the task (worktree + session + manifest) on itself. This
  // controller does NOT record the task; it surfaces via /api/fleet. A remote that
  // isn't bootstrapped yet falls through to the legacy in-process path below.
  if (host && host.kind !== "local" && host.tdsp_bin) {
    const spec = { mirror: repo.mirror_path, name: repo.name, git_url: repo.git_url, base: base_branch, title, prompt: prompt || null, skills: extraSkills };
    const b64 = Buffer.from(JSON.stringify(spec)).toString("base64");
    const out = await runTdsp(host, ["create", b64]);
    const result = parseNodeResult(out.stdout);
    if (!result) return res.status(502).json({ error: `node dispatch failed: ${(out.stderr || "no result").slice(0, 300)}` });
    if (result.ok) return res.json({ id: result.id, session: result.session, work_branch: result.workBranch, node: host.id });
    if (result.error === "skillsMissing") return res.status(400).json({ error: tr(lang, "skill.missing", { keys: (result.missing || []).join(", ") }) });
    return res.status(500).json({ error: result.message || result.error });
  }

  // local host, or a remote not yet bootstrapped: dispatch in-process on its Runner
  const r = await createRepoTask(
    repoTaskEnvFor(runnerFor(host as Host)),
    { id: repo.id, name: repo.name, mirror_path: repo.mirror_path },
    { baseBranch: base_branch, title, prompt, extraSkills },
  );
  if (r.ok) return res.json({ id: r.id, session: r.session, work_branch: r.workBranch });
  if (r.error === "skillsMissing") return res.status(400).json({ error: tr(lang, "skill.missing", { keys: r.missing.join(", ") }) });
  return res.status(500).json({ error: r.message });
});

// repo-less shell task: skip the mirror/worktree/skills machinery and just open a
// bare tmux shell in a plain dir (default the machine's home) on the chosen
// machine (host_id; default local) — the user cd's and runs claude (or anything)
// themselves. Stored in the same tasks table with kind='local', repo_id=0 and
// empty branch/worktree columns, so it rides the existing
// list/connect/archive/delete plumbing on local AND remote machines.
app.post("/api/tasks/local", async (req, res) => {
  const lang = langFromReq(req);
  const host = req.body?.host_id != null
    ? (getHost.get(req.body.host_id) as Host | undefined)
    : (db.prepare("SELECT * FROM hosts WHERE kind='local'").get() as Host | undefined);
  if (!host) return res.status(404).json({ error: tr(lang, "notFound") });
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });

  // SINK: a bootstrapped remote opens the shell on itself (it resolves the cwd
  // against its OWN home and owns the record). This controller doesn't record it.
  if (host.kind !== "local" && host.tdsp_bin) {
    const out = await runTdsp(host, ["create-local", "--cwd", String(req.body?.cwd ?? ""), "--title", String(req.body?.title ?? "")]);
    const result = parseNodeResult(out.stdout);
    if (!result) return res.status(502).json({ error: `node dispatch failed: ${(out.stderr || "no result").slice(0, 300)}` });
    if (result.ok) return res.json({ id: result.id, session: result.session, node: host.id });
    if (result.error === "cwdMissing") return res.status(400).json({ error: tr(lang, "task.cwdMissing", { cwd: String(req.body?.cwd ?? "") }) });
    return res.status(500).json({ error: result.message || result.error });
  }

  const runner = runnerFor(host);
  const home = host.kind === "local" ? os.homedir() : (await runner.exec("sh", ["-c", 'echo "$HOME"']).catch(() => "")).trim();
  const cwd = resolveCwd(req.body?.cwd, home);
  if (!(await runner.exists(cwd))) return res.status(400).json({ error: tr(lang, "task.cwdMissing", { cwd }) });
  const provided = String(req.body?.title ?? "").trim();

  // insert first so the auto-title and session name can use the row id
  const info = db.prepare(
    "INSERT INTO tasks (kind, host_id, repo_id, base_branch, work_branch, title, prompt, worktree_path, session, status, cwd) " +
    "VALUES ('local', ?, 0, '', '', ?, NULL, '', '', 'creating', ?)"
  ).run(host.id, provided, cwd);
  const id = Number(info.lastInsertRowid);
  const title = provided || tr(lang, "task.localDefaultTitle", { id });
  const session = `tdsp-${NS}-${id}-local-${slug(title)}`;

  try {
    await startShellSession(runner, session, cwd);
    db.prepare("UPDATE tasks SET title=?, session=?, status='running' WHERE id=?").run(title, session, id);
    syncTaskManifest(id);
    res.json({ id, session });
  } catch (e: any) {
    db.prepare("UPDATE tasks SET title=?, status='error', error=? WHERE id=?").run(title, String(e.message || e), id);
    syncTaskManifest(id);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// paste a screenshot into a task's claude: receive the raw image bytes, land
// them ON the task's machine (worktree for a repo task, cwd for a local task)
// via the Runner, then bracketed-paste the absolute path into the session so
// claude attaches it as an inline image. Identical local + remote (Runner).
app.post("/api/tasks/:id/paste-image", express.raw({ type: "image/*", limit: "25mb" }), async (req, res) => {
  const lang = langFromReq(req);
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: tr(lang, "notFound") });
  if (offline(taskHost(task))) return res.status(409).json({ error: tr(lang, "host.offline") });
  const ext = extForMime(req.headers["content-type"]);
  if (!ext) return res.status(400).json({ error: tr(lang, "paste.badType") });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: tr(lang, "paste.empty") });
  const base = pasteTargetBase(task);
  if (!base) return res.status(409).json({ error: tr(lang, "paste.noTarget") });

  const runner = taskRunner(task);
  const dest = pastedDest(base, pasteFilename(Date.now(), ext));
  const tmp = path.join(os.tmpdir(), `tdsp-paste-${NS}-${task.id}-${path.basename(dest)}`);
  try {
    fs.writeFileSync(tmp, req.body);
    await runner.putFile(tmp, dest); // land it ON the task's machine (local fs / ssh)
  } catch (e: any) {
    return res.status(500).json({ error: String(e.message || e) });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  // keep pasted images out of git status (best-effort; a local task's cwd may
  // not be a git repo at all — the guard makes that a clean no-op)
  await runner.exec("sh", ["-c",
    `cd ${JSON.stringify(base)} && p=$(git rev-parse --git-path info/exclude 2>/dev/null) && [ -n "$p" ] && ` +
    `{ grep -qxF '.claude/pasted/' "$p" 2>/dev/null || printf '%s\\n' '.claude/pasted/' >> "$p"; }`,
  ]).catch(() => {});
  // inject the path as a bracketed paste → claude shows [Image #N] in its input
  if (task.session) await pasteText(runner, task.session, dest).catch(() => {});
  res.json({ ok: true, path: dest });
});

// archive: end the tmux session but KEEP the worktree (moves task to archived tab)
app.post("/api/tasks/:id/archive", async (req, res) => {
  const lang = langFromReq(req);
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: tr(lang, "notFound") });
  if (offline(taskHost(task))) return res.status(409).json({ error: tr(lang, "host.offline") });
  try {
    await killSession(taskRunner(task), task.session);
    db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(task.id);
    syncTaskManifest(task.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// remove the worktree (frees disk) without deleting the task record
app.post("/api/tasks/:id/cleanup", async (req, res) => {
  const lang = langFromReq(req);
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: tr(lang, "notFound") });
  if (offline(taskHost(task))) return res.status(409).json({ error: tr(lang, "host.offline") });
  const repo = getRepo.get(task.repo_id) as Repo | undefined;
  try {
    const runner = taskRunner(task);
    await killSession(runner, task.session);
    if (repo?.mirror_path) await removeWorktree(runner, repo.mirror_path, task.worktree_path, task.work_branch);
    db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(task.id);
    syncTaskManifest(task.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// resume: bring a task's tmux session back when it died (mis-kill, host reboot,
// claude crash) but its worktree is still on disk. Relaunches `claude --continue`
// in the SAME worktree, which reopens the prior conversation (claude keys the
// transcript by cwd). Idempotent: if the session is somehow already live, just
// flip the row back to running.
app.post("/api/tasks/:id/resume", async (req, res) => {
  const lang = langFromReq(req);
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: tr(lang, "notFound") });
  if (!task.session || !task.worktree_path) return res.status(409).json({ error: tr(lang, "task.notResumable") });
  if (offline(taskHost(task))) return res.status(409).json({ error: tr(lang, "host.offline") });
  const runner = taskRunner(task);
  if (!(await runner.exists(task.worktree_path).catch(() => false))) {
    return res.status(409).json({ error: tr(lang, "task.worktreeGone") });
  }
  try {
    const alreadyAlive = await hasSession(runner, task.session).catch(() => false);
    if (!alreadyAlive) await startSession(runner, task.session, task.worktree_path, null, { continue: true });
    db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(task.id);
    syncTaskManifest(task.id);
    res.json({ ok: true, alreadyAlive });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// rename a task's display title only — pure DB update, no host/session touched
app.patch("/api/tasks/:id", (req, res) => {
  const lang = langFromReq(req);
  const r = renameTask(db, Number(req.params.id), req.body?.title);
  if ("error" in r) {
    if (r.error === "empty") return res.status(400).json({ error: tr(lang, "task.titleRequired") });
    return res.status(404).json({ error: tr(lang, "notFound") });
  }
  syncTaskManifest(Number(req.params.id));
  res.json(r);
});

// delete the task record — refused while its worktree still exists on disk
app.delete("/api/tasks/:id", async (req, res) => {
  const task = getTask.get(req.params.id) as Task | undefined;
  if (task && task.worktree_path && (await taskRunner(task).exists(task.worktree_path).catch(() => false))) {
    return res.status(409).json({ error: tr(langFromReq(req), "task.worktreeExists") });
  }
  db.prepare("DELETE FROM tasks WHERE id=?").run(req.params.id);
  removeTaskManifest(DATA_DIR, Number(req.params.id));
  res.json({ ok: true });
});

// ---------- fleet (cross-node task view) ----------
const pexecFile = promisify(execFile);

// Fetch one node's OWN task list live: `ssh <node> <wrapper> list --json`. A
// wall-clock timeout bounds a half-dead node so it degrades to "unreachable"
// (aggregateNodes catches the throw) instead of stalling the whole fleet view.
function nodeListFetch(t: FleetTarget): Promise<string> {
  return pexecFile(SSH_BIN, [...SSH_BASE_ARGS, t.target, t.bin, "list", "--json"], {
    timeout: 8000,
    maxBuffer: 64 * 1024 * 1024,
  }).then(({ stdout }) => stdout);
}

/** POSIX single-quote for the remote shell (ssh joins argv into one command). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Invoke a verb on a bootstrapped node's tdsp: `ssh <target> <bin> <args…>`.
// Args are shell-quoted for the remote shell. The one-shot create verbs exit 1
// on a failed dispatch but still print their JSON result to stdout, so we capture
// stdout in BOTH the success and error cases and let the caller parse it.
function runTdsp(host: Host, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const remote = [host.tdsp_bin as string, ...args].map(shq).join(" ");
  return pexecFile(SSH_BIN, [...SSH_BASE_ARGS, host.target, remote], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
    .then(({ stdout, stderr }) => ({ ok: true, stdout: stdout || "", stderr: stderr || "" }))
    .catch((e) => ({ ok: false, stdout: e?.stdout || "", stderr: e?.stderr || String(e?.message || e) }));
}

// Parse the trailing JSON line a tdsp verb prints (it may log before it). Returns
// null if there's no parseable result (e.g. ssh failed before tdsp ran).
function parseNodeResult(stdout: string): any | null {
  const line = stdout.trim().split("\n").pop() || "";
  try { return JSON.parse(line); } catch { return null; }
}

// One glass: every node's tasks read from its OWN truth. The local node comes
// from this controller's DB; each bootstrapped remote is fetched live and merged
// (offline → unreachable, older schema → version, no wrapper yet → notBootstrapped).
// Honest per-node status, never a silent drop.
app.get("/api/fleet", async (_req, res) => {
  const hosts = db.prepare("SELECT * FROM hosts ORDER BY (kind='local') DESC, id DESC").all() as Host[];
  const aggregated = await aggregateNodes(fleetTargets(hosts), nodeListFetch);
  const byId = new Map(aggregated.map((a) => [a.node.id, a]));
  const nodes = hosts.map((h) => {
    const base = { node: { id: h.id, name: h.name }, kind: h.kind };
    if (h.kind === "local") return { ...base, ok: true, tasks: tasksForHost(db, h.id) };
    const agg = byId.get(h.id);
    if (agg) return { ...base, ok: agg.ok, reason: agg.reason, tasks: agg.tasks ?? [] };
    return { ...base, ok: false, reason: "notBootstrapped" as const };
  });
  res.json({ schema_version: 1, nodes });
});

// ---------- sessions (raw tmux, incl. orphans) ----------
app.get("/api/sessions", async (_req, res) => {
  const names = await listSessions(localRunner);
  const known = new Set(
    (db.prepare("SELECT session FROM tasks WHERE status != 'cleaned'").all() as { session: string }[])
      .map((r) => r.session)
  );
  res.json(names.map((name) => ({ name, orphan: !known.has(name) })));
});

app.post("/api/sessions/:name/kill", async (req, res) => {
  const lang = langFromReq(req);
  const name = req.params.name;
  if (!SESSION_RE.test(name)) return res.status(400).json({ error: tr(lang, "session.invalid") });
  const task = db.prepare("SELECT * FROM tasks WHERE session=?").get(name) as Task | undefined;
  // An orphan (no task row in THIS controller's db) may be a LIVE session owned
  // by another controller that shares this machine's tmux server — killing it
  // would tear down their work (exactly the cross-controller accident the
  // single-controller rule warns about). Refuse unless explicitly forced.
  if (!task && req.body?.force !== true) {
    return res.status(409).json({ error: tr(lang, "session.orphanRefused", { name }) });
  }
  const removeWt = req.body?.removeWorktree !== false; // default: also delete worktree
  const runner = task ? taskRunner(task) : localRunner;
  await killSession(runner, name);

  let removedWorktree = false;
  if (task) {
    if (removeWt) {
      const repo = getRepo.get(task.repo_id) as Repo | undefined;
      if (repo?.mirror_path) await removeWorktree(runner, repo.mirror_path, task.worktree_path, task.work_branch);
      db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(task.id);
      syncTaskManifest(task.id);
      removedWorktree = true;
    } else {
      db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(task.id);
      syncTaskManifest(task.id);
    }
  }
  res.json({ ok: true, removedWorktree });
});

// ---------- hosts (remote machines, terminal-only L1) ----------
app.get("/api/hosts", (_req, res) => {
  // local machine (#0) first, then remotes
  res.json(db.prepare("SELECT * FROM hosts ORDER BY (kind='local') DESC, id DESC").all());
});

app.post("/api/hosts", (req, res) => {
  const { name, target, kind } = req.body ?? {};
  if (!name || !target) return res.status(400).json({ error: "name and target required" });
  const k = kind === "mosh" ? "mosh" : "ssh";
  const info = db.prepare("INSERT INTO hosts (name, target, kind) VALUES (?,?,?)")
    .run(String(name).trim(), String(target).trim(), k);
  const id = Number(info.lastInsertRowid);
  probeHost(getHost.get(id) as Host); // probe right away so it goes online fast (fire-and-forget)
  res.json({ id });
});

// Run a shell script ON a machine via `ssh target sh -s`, fed over STDIN. This is
// the bootstrap probe transport: stdin-fed avoids the nested-quote trap where the
// remote shell would expand `$(fnm env)` before our script ever runs. No timeout —
// npm install is deliberately long; bootstrap is a foreground, user-initiated op.
function sshRun(target: string): (script: string) => Promise<{ ok: boolean; stdout: string }> {
  return (script) =>
    new Promise((resolve) => {
      const c = spawnChild(SSH_BIN, [...SSH_BASE_ARGS, target, "sh -s"]);
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", (code) => resolve({ ok: code === 0, stdout: out }));
      c.on("error", () => resolve({ ok: false, stdout: "" }));
      c.stdin.on("error", () => {});
      c.stdin.write(script);
      c.stdin.end();
    });
}

// Install tdsp onto a remote machine and record its wrapper path (tdsp_bin) so the
// fleet view can reach it and control can sink to it. Stages the app source (no
// node_modules — npm install rebuilds native modules for the target's arch), then
// runs the bootstrap sequence. Foreground: the response returns when it's done.
app.post("/api/hosts/:id/bootstrap", async (req, res) => {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.id) as Host | undefined;
  if (!host) return res.status(404).json({ error: tr(lang, "notFound") });
  if (host.kind === "local") return res.status(400).json({ error: "the local machine needs no bootstrap" });
  if (host.status !== "online") return res.status(409).json({ error: tr(lang, "host.offline") });

  const runner = runnerFor(host);
  const home = (await runner.exec("sh", ["-c", 'echo "$HOME"']).catch(() => "")).trim();
  if (!home) return res.status(502).json({ error: "could not resolve the machine's home dir" });

  // stage just the app source (server/, web/, manifests) — never node_modules
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-stage-"));
  try {
    for (const d of ["server", "web"]) fs.cpSync(path.join(ROOT, d), path.join(stage, d), { recursive: true });
    for (const f of ["package.json", "package-lock.json", "tsconfig.json"]) {
      const src = path.join(ROOT, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stage, f));
    }
    const result = await bootstrapMachine({
      appSrcDir: stage,
      home,
      run: sshRun(host.target),
      pushDir: (src, dest) => runner.putDir(src, dest),
      override: typeof req.body?.nodeOverride === "string" && req.body.nodeOverride.trim() ? req.body.nodeOverride.trim() : undefined,
    });
    if (!result.ok) return res.status(500).json({ error: result.error });
    db.prepare("UPDATE hosts SET tdsp_bin=? WHERE id=?").run(result.binPath, host.id);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

app.delete("/api/hosts/:id", (req, res) => {
  const host = getHost.get(req.params.id) as Host | undefined;
  if (host?.kind === "local") return res.status(409).json({ error: "cannot delete the local machine" });
  const n = (db.prepare("SELECT count(*) AS c FROM repos WHERE host_id=?").get(req.params.id) as { c: number }).c;
  if (n > 0) return res.status(409).json({ error: "remove this machine's repos first" });
  db.prepare("DELETE FROM hosts WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- skills (read-through aggregation; nothing stored) ----------
app.get("/api/skills", (_req, res) => {
  res.json(scanSkills(defaultSources()).map(({ key, name, description, source }) => ({ key, name, description, source })));
});

// ---------- plugin install (official channel; populates the skill sources) ----------
app.get("/api/plugins/available", async (_req, res) => {
  try { res.json(await listAvailable()); }
  catch (e: any) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/api/plugins/install", async (req, res) => {
  const { pluginId } = req.body ?? {};
  if (!pluginId) return res.status(400).json({ error: tr(langFromReq(req), "plugin.idRequired") });
  try {
    await installPlugin(String(pluginId));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- pty bridge ----------
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Route upgrades by Host first (a preview's HMR socket), then by path (/pty).
server.on("upgrade", (req, socket, head) => {
  if (parsePreviewHost(req.headers.host)) {
    handlePreviewUpgrade(req, socket, head, resolvePreviewUpstream);
    return;
  }
  const { pathname } = new URL(req.url || "", "http://localhost");
  if (pathname === "/pty") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }
  socket.destroy();
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", "http://localhost");
  const session = url.searchParams.get("session");
  const lang = langFromQuery(url.searchParams.get("lang"));

  // attach the relay to a task's tmux session, on whichever machine the task
  // lives: local tmux, or ssh/mosh into the remote and attach there. node-pty
  // spawns the client locally; the shell/tmux/files all live ON that machine.
  if (!session || !SESSION_RE.test(session)) { ws.close(1008, "invalid target"); return; }
  const task = db.prepare("SELECT * FROM tasks WHERE session=?").get(session) as Task | undefined;
  const host = task ? taskHost(task) : undefined;
  const { file, args, label } = attachCommand(host, session, { ssh: SSH_BIN, mosh: MOSH_BIN, tmux: TMUX_BIN });
  // the session whose copy/scroll mode we cancel on attach, so this client lands
  // on the live prompt no matter what mode a previous client left the pane in.
  const cancelRunner: Runner = host ? runnerFor(host) : localRunner;
  const cancelSession = session;

  // multiple clients can attach independently (tmux/ssh both handle this)
  let term: pty.IPty;
  try {
    term = spawnPty(file, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: process.env.HOME,
      env: process.env as Record<string, string>,
    });
  } catch (e: any) {
    // spawn failure must not crash the server — report on the socket and bail
    try { ws.send(`\r\n\x1b[31m${tr(lang, "session.attachFailed", { session: label, error: e.message })}\x1b[0m\r\n`); } catch {}
    ws.close();
    return;
  }

  // best-effort, fire-and-forget: nudge the pane out of copy/scroll mode so this
  // attach shows the live prompt. NOT awaited — the listeners below must register
  // synchronously, before the client's first resize arrives, or it gets dropped.
  if (cancelRunner) cancelCopyMode(cancelRunner, cancelSession);

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on("message", (raw) => {
    const msg = raw.toString();
    if (msg.startsWith("\x00resize:")) {
      const [, dims] = msg.split(":");
      const [cols, rows] = dims.split("x").map(Number);
      if (cols && rows) term.resize(cols, rows);
      return;
    }
    term.write(msg);
  });

  ws.on("close", () => {
    // detach (don't kill the tmux session) by sending the tmux detach key isn't
    // reliable here; killing the attach client process is enough.
    term.kill();
  });
});

if (DID_MIGRATE) repairWorktrees(); // fix git worktree links after the ./data move
startLivenessLoop();                // background ssh probe of remote machines
syncReposManifest();                // bootstrap repos.json from the current catalog on boot
// adopt any task manifests on disk this DB is missing (recover a wiped db / own
// tasks present locally), then backfill manifests for every task we own so the
// on-disk catalog mirrors the table.
adoptTaskManifests(db, readTaskManifests(DATA_DIR));
for (const { id } of db.prepare("SELECT id FROM tasks").all() as { id: number }[]) syncTaskManifest(id);

const PORT = Number(process.env.PORT || 4500);
// Bind loopback by default — the web terminal is a live shell, so don't expose
// it on the LAN unless explicitly asked. Set HOST=0.0.0.0 to listen on all
// interfaces (then put auth / a reverse proxy in front), or use an ssh tunnel
// (ssh -L 4500:localhost:4500 host) for remote access.
const HOST = process.env.HOST || "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.log(`task-dispatcher on http://${HOST}:${PORT}`);
});
