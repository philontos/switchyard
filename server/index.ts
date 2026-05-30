import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import fs from "node:fs";
import path from "node:path";
import { db, Repo, Task } from "./db.js";
import {
  cloneMirror, fetchMirror, listBranches, addWorktree, removeWorktree,
  pushBranch, mirrorPath,
} from "./git.js";
import { startSession, hasSession, killSession } from "./tmux.js";
import { createMR } from "./mr.js";
import { WEB_DIR } from "./paths.js";

const app = express();
app.use(express.json());
app.use(express.static(WEB_DIR));

const getRepo = db.prepare("SELECT * FROM repos WHERE id = ?");
const getTask = db.prepare("SELECT * FROM tasks WHERE id = ?");

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
}

// ---------- repos ----------
app.get("/api/repos", (_req, res) => {
  res.json(db.prepare("SELECT id,name,git_url,default_branch,project_path,status,error,created_at FROM repos ORDER BY id DESC").all());
});

app.post("/api/repos", (req, res) => {
  const { name, git_url, token, default_branch, project_path } = req.body ?? {};
  if (!name || !git_url) return res.status(400).json({ error: "name and git_url required" });
  const info = db.prepare(
    "INSERT INTO repos (name, git_url, token, default_branch, project_path, status) VALUES (?,?,?,?,?,?)"
  ).run(name, git_url, token || null, default_branch || "main", project_path || null, "cloning");
  const id = Number(info.lastInsertRowid);
  const dest = mirrorPath(id, name);
  db.prepare("UPDATE repos SET mirror_path = ? WHERE id = ?").run(dest, id);

  // clone in background
  (async () => {
    try {
      await cloneMirror(git_url, token || null, dest);
      db.prepare("UPDATE repos SET status='ready', error=NULL WHERE id=?").run(id);
    } catch (e: any) {
      db.prepare("UPDATE repos SET status='error', error=? WHERE id=?").run(String(e.message || e), id);
    }
  })();

  res.json({ id });
});

app.post("/api/repos/:id/fetch", async (req, res) => {
  const repo = getRepo.get(req.params.id) as Repo | undefined;
  if (!repo || !repo.mirror_path) return res.status(404).json({ error: "not found" });
  try {
    await fetchMirror(repo.mirror_path, repo.git_url, repo.token);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/repos/:id/branches", async (req, res) => {
  const repo = getRepo.get(req.params.id) as Repo | undefined;
  if (!repo || !repo.mirror_path) return res.status(404).json({ error: "not found" });
  if (repo.status !== "ready") return res.status(409).json({ error: `repo ${repo.status}` });
  try {
    res.json(await listBranches(repo.mirror_path));
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete("/api/repos/:id", (req, res) => {
  const repo = getRepo.get(req.params.id) as Repo | undefined;
  if (!repo) return res.status(404).json({ error: "not found" });
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
    tasks.map(async (t) => ({ ...t, alive: t.status === "cleaned" ? false : await hasSession(t.session) }))
  );
  res.json(withLive);
});

app.post("/api/tasks", async (req, res) => {
  const { repo_id, base_branch, title, prompt } = req.body ?? {};
  if (!repo_id || !base_branch || !title) {
    return res.status(400).json({ error: "repo_id, base_branch, title required" });
  }
  const repo = getRepo.get(repo_id) as Repo | undefined;
  if (!repo || !repo.mirror_path) return res.status(404).json({ error: "repo not found" });
  if (repo.status !== "ready") return res.status(409).json({ error: `repo ${repo.status}` });

  const info = db.prepare(
    "INSERT INTO tasks (repo_id, base_branch, work_branch, title, prompt, worktree_path, session, status) VALUES (?,?,?,?,?,?,?,?)"
  ).run(repo_id, base_branch, "", title, prompt || null, "", "", "creating");
  const id = Number(info.lastInsertRowid);
  const workBranch = `feat/${id}-${slug(title)}`;
  const worktree = path.join(path.dirname(repo.mirror_path), "..", "worktrees", `${repo.id}-${id}`);
  const wtAbs = path.resolve(worktree);
  const session = `task-${id}`;

  try {
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

app.post("/api/tasks/:id/mr", async (req, res) => {
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: "not found" });
  const repo = getRepo.get(task.repo_id) as Repo | undefined;
  const { target_branch, title } = req.body ?? {};
  try {
    await pushBranch(task.worktree_path, task.work_branch);
    const url = await createMR({
      worktree: task.worktree_path,
      projectPath: repo?.project_path,
      source: task.work_branch,
      target: target_branch || repo?.default_branch || "main",
      title: title || task.title,
    });
    db.prepare("UPDATE tasks SET mr_url=? WHERE id=?").run(url, task.id);
    res.json({ url });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/tasks/:id/cleanup", async (req, res) => {
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: "not found" });
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

app.delete("/api/tasks/:id", (req, res) => {
  db.prepare("DELETE FROM tasks WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- pty bridge ----------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/pty" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", "http://localhost");
  const session = url.searchParams.get("session");
  if (!session || !/^task-\d+$/.test(session)) {
    ws.close(1008, "invalid session");
    return;
  }
  // attach to the tmux session; multiple clients can attach independently
  const term = pty.spawn("tmux", ["attach", "-t", session], {
    name: "xterm-256color",
    cols: 120,
    rows: 32,
    cwd: process.env.HOME,
    env: process.env as Record<string, string>,
  });

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
