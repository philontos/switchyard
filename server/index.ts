import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import fs from "node:fs";
import path from "node:path";
import { db, Repo, Task, Host, Preset } from "./db.js";
import {
  initMirror, fetchMirror, fetchBranch, listBranches, addWorktree, removeWorktree,
  mirrorPath,
} from "./git.js";
import { scanSkills, resolveSkills, defaultSources } from "./skills.js";
import { renderDispatchPrompt, skillsLine } from "./presets.js";
import { startSession, hasSession, killSession, listSessions } from "./tmux.js";
import { syncReposManifest } from "./manifest.js";
import { repairWorktrees } from "./migrate.js";
import { localRunner, runnerFor } from "./runner.js";
import { startLivenessLoop, probeHost } from "./liveness.js";
import { WEB_DIR, DID_MIGRATE } from "./paths.js";
import { tr, langFromReq, langFromQuery } from "./i18n.js";

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
app.use(express.static(WEB_DIR));

const getRepo = db.prepare("SELECT * FROM repos WHERE id = ?");
const getTask = db.prepare("SELECT * FROM tasks WHERE id = ?");
const getHost = db.prepare("SELECT * FROM hosts WHERE id = ?");

// the Runner for a task's machine (via its repo's host) — local or remote(ssh)
function taskRunner(task: Task) {
  const repo = getRepo.get(task.repo_id) as Repo | undefined;
  const host = repo ? (getHost.get(repo.host_id) as Host) : undefined;
  return host ? runnerFor(host) : localRunner;
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
}

// matches dispatcher-owned sessions (new tdsp-* scheme + legacy task-N)
const SESSION_RE = /^(tdsp|task)-\d+(-[a-z0-9-]+)?$/;

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
  const repo = getRepo.get(req.params.id) as Repo | undefined;
  if (!repo || !repo.mirror_path) return res.status(404).json({ error: tr(langFromReq(req), "notFound") });
  try {
    await fetchMirror(runnerFor(getHost.get(repo.host_id) as Host), repo.mirror_path, repo.git_url, repo.token);
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

app.delete("/api/repos/:id", async (req, res) => {
  const repo = getRepo.get(req.params.id) as Repo | undefined;
  if (!repo) return res.status(404).json({ error: tr(langFromReq(req), "notFound") });
  if (repo.mirror_path) {
    // remove the bare mirror on whichever machine it lives
    await runnerFor(getHost.get(repo.host_id) as Host).rmrf(repo.mirror_path).catch(() => {});
  }
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
      return {
        ...t,
        alive: t.status === "cleaned" ? false : await hasSession(runner, t.session).catch(() => false),
        hasWorktree: !!t.worktree_path && (await runner.exists(t.worktree_path).catch(() => false)),
      };
    })
  );
  res.json(withLive);
});

app.post("/api/tasks", async (req, res) => {
  const { repo_id, base_branch, title, prompt } = req.body ?? {};
  const lang = langFromReq(req);
  if (!repo_id || !base_branch || !title) {
    return res.status(400).json({ error: tr(lang, "task.fieldsRequired") });
  }
  const repo = getRepo.get(repo_id) as Repo | undefined;
  if (!repo || !repo.mirror_path) return res.status(404).json({ error: tr(lang, "repo.notFound") });
  if (repo.status !== "ready") return res.status(409).json({ error: tr(lang, "repo.status", { status: repo.status }) });
  const runner = runnerFor(getHost.get(repo.host_id) as Host); // dispatch ON the repo's machine

  const info = db.prepare(
    "INSERT INTO tasks (repo_id, base_branch, work_branch, title, prompt, worktree_path, session, status) VALUES (?,?,?,?,?,?,?,?)"
  ).run(repo_id, base_branch, "", title, prompt || null, "", "", "creating");
  const id = Number(info.lastInsertRowid);
  const s = slug(title);
  const workBranch = `feat/${id}-${s}`;
  const worktree = path.join(path.dirname(repo.mirror_path), "..", "worktrees", `${repo.id}-${id}`);
  const wtAbs = path.resolve(worktree);
  // distinctive name so it never collides with unrelated tmux sessions
  const session = `tdsp-${id}-${slug(repo.name)}-${s}`;

  try {
    await fetchBranch(runner, repo.mirror_path, base_branch); // pull latest of base branch now
    await addWorktree(runner, repo.mirror_path, wtAbs, workBranch, base_branch);
    await startSession(runner, session, wtAbs, prompt);
    db.prepare("UPDATE tasks SET work_branch=?, worktree_path=?, session=?, status='running' WHERE id=?")
      .run(workBranch, wtAbs, session, id);
    res.json({ id, session, work_branch: workBranch });
  } catch (e: any) {
    // a partial dispatch (e.g. session start failed after the worktree was made)
    // would orphan the worktree — remove it so nothing is left behind
    await removeWorktree(runner, repo.mirror_path, wtAbs, workBranch).catch(() => {});
    db.prepare("UPDATE tasks SET status='error', error=? WHERE id=?").run(String(e.message || e), id);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// archive: end the tmux session but KEEP the worktree (moves task to archived tab)
app.post("/api/tasks/:id/archive", async (req, res) => {
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: tr(langFromReq(req), "notFound") });
  try {
    await killSession(taskRunner(task), task.session);
    db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(task.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// remove the worktree (frees disk) without deleting the task record
app.post("/api/tasks/:id/cleanup", async (req, res) => {
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: tr(langFromReq(req), "notFound") });
  const repo = getRepo.get(task.repo_id) as Repo | undefined;
  try {
    const runner = taskRunner(task);
    await killSession(runner, task.session);
    if (repo?.mirror_path) await removeWorktree(runner, repo.mirror_path, task.worktree_path, task.work_branch);
    db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(task.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// delete the task record — refused while its worktree still exists on disk
app.delete("/api/tasks/:id", async (req, res) => {
  const task = getTask.get(req.params.id) as Task | undefined;
  if (task && task.worktree_path && (await taskRunner(task).exists(task.worktree_path).catch(() => false))) {
    return res.status(409).json({ error: tr(langFromReq(req), "task.worktreeExists") });
  }
  db.prepare("DELETE FROM tasks WHERE id=?").run(req.params.id);
  res.json({ ok: true });
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
  const name = req.params.name;
  if (!SESSION_RE.test(name)) return res.status(400).json({ error: tr(langFromReq(req), "session.invalid") });
  const removeWt = req.body?.removeWorktree !== false; // default: also delete worktree
  const task = db.prepare("SELECT * FROM tasks WHERE session=?").get(name) as Task | undefined;
  const runner = task ? taskRunner(task) : localRunner;
  await killSession(runner, name);

  let removedWorktree = false;
  if (task) {
    if (removeWt) {
      const repo = getRepo.get(task.repo_id) as Repo | undefined;
      if (repo?.mirror_path) await removeWorktree(runner, repo.mirror_path, task.worktree_path, task.work_branch);
      db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(task.id);
      removedWorktree = true;
    } else {
      db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(task.id);
    }
  }
  res.json({ ok: true, removedWorktree });
});

// ---------- hosts (remote machines, terminal-only L1) ----------
const SESSION_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

app.get("/api/hosts", (_req, res) => {
  // local machine (#0) first, then remotes
  res.json(db.prepare("SELECT * FROM hosts ORDER BY (kind='local') DESC, id DESC").all());
});

app.post("/api/hosts", (req, res) => {
  const { name, target, kind, session } = req.body ?? {};
  if (!name || !target) return res.status(400).json({ error: "name and target required" });
  const k = kind === "mosh" ? "mosh" : "ssh";
  const sess = (session || "main").trim();
  if (!SESSION_NAME_RE.test(sess)) return res.status(400).json({ error: "invalid session name" });
  const info = db.prepare("INSERT INTO hosts (name, target, kind, session) VALUES (?,?,?,?)")
    .run(String(name).trim(), String(target).trim(), k, sess);
  const id = Number(info.lastInsertRowid);
  probeHost(getHost.get(id) as Host); // probe right away so it goes online fast (fire-and-forget)
  res.json({ id });
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

// ---------- presets (preset task templates: opening prompt + referenced skills) ----------
app.get("/api/presets", (_req, res) => {
  res.json(db.prepare("SELECT * FROM presets ORDER BY id DESC").all());
});

app.post("/api/presets", (req, res) => {
  const { name, description, dispatch_prompt, skill_refs } = req.body ?? {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: tr(langFromReq(req), "preset.nameRequired") });
  const refs = Array.isArray(skill_refs) ? skill_refs.map(String) : [];
  const info = db.prepare(
    "INSERT INTO presets (name, description, dispatch_prompt, skill_refs) VALUES (?,?,?,?)"
  ).run(String(name).trim(), description ?? null, dispatch_prompt ?? null, JSON.stringify(refs));
  res.json({ id: Number(info.lastInsertRowid) });
});

app.delete("/api/presets/:id", (req, res) => {
  db.prepare("DELETE FROM presets WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- pty bridge ----------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/pty" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", "http://localhost");
  const hostId = url.searchParams.get("host");
  const session = url.searchParams.get("session");
  const lang = langFromQuery(url.searchParams.get("lang"));

  // resolve the connection target: a local tmux session, or a remote machine.
  // remote = node-pty spawns ssh/mosh locally, but the shell/tmux/files all
  // live ON the remote host — this box is just the relay.
  let file: string, args: string[], label: string;
  if (hostId) {
    const host = getHost.get(hostId) as Host | undefined;
    if (!host) { ws.close(1008, "unknown host"); return; }
    label = `${host.kind} ${host.target}`;
    // just forward — the remote's shell env (the user's responsibility) resolves
    // tmux. attach to, or create, the named session.
    const remoteCmd = `exec tmux new-session -A -s ${host.session}`;
    if (host.kind === "mosh") {
      file = MOSH_BIN;
      args = [host.target, "--", "sh", "-c", remoteCmd];
    } else {
      file = SSH_BIN;
      args = ["-t", host.target, remoteCmd];
    }
  } else if (session && SESSION_RE.test(session)) {
    // a task's tmux session — attach on whichever machine the task lives
    const task = db.prepare("SELECT * FROM tasks WHERE session=?").get(session) as Task | undefined;
    const repo = task ? (getRepo.get(task.repo_id) as Repo | undefined) : undefined;
    const host = repo ? (getHost.get(repo.host_id) as Host | undefined) : undefined;
    if (host && host.kind !== "local") {
      file = SSH_BIN;
      args = ["-t", host.target, `exec tmux attach -t ${session}`];
      label = `${host.target} ${session}`;
    } else {
      file = TMUX_BIN;
      args = ["attach", "-t", session];
      label = session;
    }
  } else {
    ws.close(1008, "invalid target");
    return;
  }

  // multiple clients can attach independently (tmux/ssh both handle this)
  let term: pty.IPty;
  try {
    term = pty.spawn(file, args, {
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

const PORT = Number(process.env.PORT || 4500);
server.listen(PORT, () => {
  console.log(`task-dispatcher on http://localhost:${PORT}`);
});
