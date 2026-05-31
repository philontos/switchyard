import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import fs from "node:fs";
import path from "node:path";
import { db, Repo, Task } from "./db.js";
import {
  initMirror, fetchMirror, fetchBranch, listBranches, addWorktree, removeWorktree,
  mirrorPath,
} from "./git.js";
import { startSession, hasSession, killSession, listSessions } from "./tmux.js";
import { WEB_DIR } from "./paths.js";
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

const app = express();
app.use(express.json());
app.use(express.static(WEB_DIR));

const getRepo = db.prepare("SELECT * FROM repos WHERE id = ?");
const getTask = db.prepare("SELECT * FROM tasks WHERE id = ?");

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
}

// matches dispatcher-owned sessions (new tdsp-* scheme + legacy task-N)
const SESSION_RE = /^(tdsp|task)-\d+(-[a-z0-9-]+)?$/;

// ---------- repos ----------
app.get("/api/repos", (_req, res) => {
  res.json(db.prepare("SELECT id,name,git_url,default_branch,project_path,status,error,created_at FROM repos ORDER BY id DESC").all());
});

app.post("/api/repos", (req, res) => {
  const { name, git_url, token, default_branch, project_path } = req.body ?? {};
  if (!name || !git_url) return res.status(400).json({ error: tr(langFromReq(req), "repo.fieldsRequired") });
  const info = db.prepare(
    "INSERT INTO repos (name, git_url, token, default_branch, project_path, status) VALUES (?,?,?,?,?,?)"
  ).run(name, git_url, token || null, default_branch || "main", project_path || null, "cloning");
  const id = Number(info.lastInsertRowid);
  const dest = mirrorPath(id, name);
  db.prepare("UPDATE repos SET mirror_path = ? WHERE id = ?").run(dest, id);

  // register in background: init bare repo + validate connectivity (no download)
  (async () => {
    try {
      await initMirror(git_url, token || null, dest);
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
    await fetchMirror(repo.mirror_path, repo.git_url, repo.token);
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
    res.json(await listBranches(repo.mirror_path));
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete("/api/repos/:id", (req, res) => {
  const repo = getRepo.get(req.params.id) as Repo | undefined;
  if (!repo) return res.status(404).json({ error: tr(langFromReq(req), "notFound") });
  if (repo.mirror_path && fs.existsSync(repo.mirror_path)) {
    fs.rmSync(repo.mirror_path, { recursive: true, force: true });
  }
  db.prepare("DELETE FROM repos WHERE id=?").run(repo.id);
  res.json({ ok: true });
});

// ---------- tasks ----------
app.get("/api/tasks", async (_req, res) => {
  const tasks = db.prepare("SELECT * FROM tasks ORDER BY id DESC").all() as Task[];
  const withLive = await Promise.all(
    tasks.map(async (t) => ({
      ...t,
      alive: t.status === "cleaned" ? false : await hasSession(t.session),
      hasWorktree: !!t.worktree_path && fs.existsSync(t.worktree_path),
    }))
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
    await fetchBranch(repo.mirror_path, base_branch); // pull latest of base branch now
    await addWorktree(repo.mirror_path, wtAbs, workBranch, base_branch);
    await startSession(session, wtAbs, prompt);
    db.prepare("UPDATE tasks SET work_branch=?, worktree_path=?, session=?, status='running' WHERE id=?")
      .run(workBranch, wtAbs, session, id);
    res.json({ id, session, work_branch: workBranch });
  } catch (e: any) {
    db.prepare("UPDATE tasks SET status='error', error=? WHERE id=?").run(String(e.message || e), id);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// archive: end the tmux session but KEEP the worktree (moves task to archived tab)
app.post("/api/tasks/:id/archive", async (req, res) => {
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: tr(langFromReq(req), "notFound") });
  try {
    await killSession(task.session);
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
    await killSession(task.session);
    if (repo?.mirror_path) await removeWorktree(repo.mirror_path, task.worktree_path, task.work_branch);
    db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(task.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// delete the task record — refused while its worktree still exists on disk
app.delete("/api/tasks/:id", (req, res) => {
  const task = getTask.get(req.params.id) as Task | undefined;
  if (task && task.worktree_path && fs.existsSync(task.worktree_path)) {
    return res.status(409).json({ error: tr(langFromReq(req), "task.worktreeExists") });
  }
  db.prepare("DELETE FROM tasks WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- sessions (raw tmux, incl. orphans) ----------
app.get("/api/sessions", async (_req, res) => {
  const names = await listSessions();
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
  await killSession(name);

  const task = db.prepare("SELECT * FROM tasks WHERE session=?").get(name) as Task | undefined;
  let removedWorktree = false;
  if (task) {
    if (removeWt) {
      const repo = getRepo.get(task.repo_id) as Repo | undefined;
      if (repo?.mirror_path) await removeWorktree(repo.mirror_path, task.worktree_path, task.work_branch);
      db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(task.id);
      removedWorktree = true;
    } else {
      db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(task.id);
    }
  }
  res.json({ ok: true, removedWorktree });
});

// ---------- pty bridge ----------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/pty" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", "http://localhost");
  const session = url.searchParams.get("session");
  const lang = langFromQuery(url.searchParams.get("lang"));
  if (!session || !SESSION_RE.test(session)) {
    ws.close(1008, "invalid session");
    return;
  }
  // attach to the tmux session; multiple clients can attach independently
  let term: pty.IPty;
  try {
    term = pty.spawn(TMUX_BIN, ["attach", "-t", session], {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: process.env.HOME,
      env: process.env as Record<string, string>,
    });
  } catch (e: any) {
    // spawn failure must not crash the server — report on the socket and bail
    try { ws.send(`\r\n\x1b[31m${tr(lang, "session.attachFailed", { session, error: e.message })}\x1b[0m\r\n`); } catch {}
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

const PORT = Number(process.env.PORT || 4500);
server.listen(PORT, () => {
  console.log(`task-dispatcher on http://localhost:${PORT}`);
});
