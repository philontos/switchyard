import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { spawnPty } from "./pty.js";
import { attachCommand } from "./attach.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, Repo, Task, Host, Preset } from "./db.js";
import { renameTask } from "./tasks.js";
import {
  initMirror, fetchMirror, fetchBranch, listBranches, addWorktree, removeWorktree,
  mirrorPath,
} from "./git.js";
import { scanSkills, resolveSkills, defaultSources } from "./skills.js";
import { renderDispatchPrompt, skillsLine } from "./presets.js";
import { extForMime, pasteTargetBase, pastedDest, pasteFilename } from "./paste.js";
import { listAvailable, installPlugin } from "./plugins.js";
import { startSession, startShellSession, hasSession, killSession, listSessions, cancelCopyMode, pasteText } from "./tmux.js";
import { syncReposManifest } from "./manifest.js";
import { repairWorktrees } from "./migrate.js";
import { localRunner, runnerFor, type Runner } from "./runner.js";
import { resolveCwd } from "./local.js";
import { hookSettingsJson } from "./hooks.js";
import { startLivenessLoop, probeHost } from "./liveness.js";
import { WEB_DIR, DID_MIGRATE, NS } from "./paths.js";
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
      return {
        ...t,
        alive: t.status === "cleaned" ? false : await hasSession(runner, t.session).catch(() => false),
        hasWorktree: !!t.worktree_path && (await runner.exists(t.worktree_path).catch(() => false)),
        // yellow light: the session's hook touches <wt>/.claude/waiting when it
        // blocks on a permission prompt; runner.exists reads it back the same way
        // on the local box (fs) and on a remote (ssh test -e). No worktree → never.
        waiting: t.status !== "cleaned" && !!t.worktree_path
          && (await runner.exists(path.join(t.worktree_path, ".claude/waiting")).catch(() => false)),
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
  const host = getHost.get(repo.host_id) as Host | undefined;
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const runner = runnerFor(host as Host); // dispatch ON the repo's machine

  // Resolve the preset + skills to inject and PREFLIGHT them: if any referenced
  // skill is missing, fail now — before any worktree/task is created — so we
  // never leave a half-built task pointing at a nonexistent skill.
  const presetId = req.body?.preset_id ?? null;
  const extraSkills: string[] = Array.isArray(req.body?.extra_skills) ? req.body.extra_skills.map(String) : [];
  const preset = presetId ? (db.prepare("SELECT * FROM presets WHERE id=?").get(presetId) as Preset | undefined) : undefined;
  if (presetId && !preset) return res.status(404).json({ error: tr(lang, "preset.notFound") });
  const wantKeys = [...new Set([...(preset ? (JSON.parse(preset.skill_refs) as string[]) : []), ...extraSkills])];
  const { found, missing } = resolveSkills(wantKeys, defaultSources());
  if (missing.length) return res.status(400).json({ error: tr(lang, "skill.missing", { keys: missing.join(", ") }) });

  const info = db.prepare(
    "INSERT INTO tasks (repo_id, base_branch, work_branch, title, prompt, worktree_path, session, status, preset_id, skills) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(repo_id, base_branch, "", title, prompt || null, "", "", "creating", presetId, JSON.stringify(found.map((f) => f.key)));
  const id = Number(info.lastInsertRowid);
  const s = slug(title);
  const workBranch = `feat/${id}-${s}`;
  const worktree = path.join(path.dirname(repo.mirror_path), "..", "worktrees", `${repo.id}-${id}`);
  const wtAbs = path.resolve(worktree);
  // distinctive name so it never collides with unrelated tmux sessions
  const session = `tdsp-${NS}-${id}-${slug(repo.name)}-${s}`;

  try {
    await fetchBranch(runner, repo.mirror_path, base_branch); // pull latest of base branch now
    await addWorktree(runner, repo.mirror_path, wtAbs, workBranch, base_branch);
    // deliver each selected skill's whole dir into the worktree's .claude/skills/
    for (const sk of found) await runner.putDir(sk.dir, path.join(wtAbs, ".claude", "skills", sk.name));
    // keep delivered skills out of the repo's git status (worktree-local exclude)
    if (found.length) {
      await runner.exec("sh", ["-c",
        `cd ${JSON.stringify(wtAbs)} && p=$(git rev-parse --git-path info/exclude) && grep -qxF '.claude/skills/' "$p" || printf '.claude/skills/\\n' >> "$p"`,
      ]).catch(() => {});
    }
    // inject per-task hooks so the session reports when it's blocked on a
    // permission prompt (yellow light): the hook touches/removes <wt>/.claude/waiting,
    // which the dispatcher reads back via runner.exists — same on the local box and
    // on remotes. Deliver settings.local.json through putDir (overlays the .claude
    // skills/ already there); keep both injected paths out of the repo's git status.
    const hooksTmp = path.join(os.tmpdir(), `tdsp-hooks-${NS}-${id}`, ".claude");
    fs.mkdirSync(hooksTmp, { recursive: true });
    fs.writeFileSync(path.join(hooksTmp, "settings.local.json"), hookSettingsJson(wtAbs));
    await runner.putDir(hooksTmp, path.join(wtAbs, ".claude"));
    fs.rmSync(path.dirname(hooksTmp), { recursive: true, force: true });
    await runner.exec("sh", ["-c",
      `cd ${JSON.stringify(wtAbs)} && p=$(git rev-parse --git-path info/exclude) && ` +
      `for f in '.claude/settings.local.json' '.claude/waiting'; do grep -qxF "$f" "$p" || printf '%s\\n' "$f" >> "$p"; done`,
    ]).catch(() => {});
    // opening message: preset template (if any) else the freeform prompt, + skills line
    const vars = { title, slug: s, branch: workBranch, prompt: prompt || "" };
    const opening = (preset ? renderDispatchPrompt(preset.dispatch_prompt || "", vars) : (prompt || ""))
      + skillsLine(found.map((f) => f.name));
    await startSession(runner, session, wtAbs, opening.trim() ? opening : null);
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
    res.json({ id, session });
  } catch (e: any) {
    db.prepare("UPDATE tasks SET title=?, status='error', error=? WHERE id=?").run(title, String(e.message || e), id);
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
    res.json({ ok: true });
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
  res.json(r);
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
      removedWorktree = true;
    } else {
      db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(task.id);
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

// ---------- plugin install (official channel; populates the skill sources) ----------
app.get("/api/plugins/available", async (_req, res) => {
  try { res.json(await listAvailable()); }
  catch (e: any) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/api/plugins/install", async (req, res) => {
  const { pluginId, target } = req.body ?? {};
  if (!pluginId) return res.status(400).json({ error: tr(langFromReq(req), "plugin.idRequired") });
  try {
    await installPlugin(String(pluginId), target === "dispatcher" ? "dispatcher" : "global");
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- pty bridge ----------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/pty" });

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

const PORT = Number(process.env.PORT || 4500);
// Bind loopback by default — the web terminal is a live shell, so don't expose
// it on the LAN unless explicitly asked. Set HOST=0.0.0.0 to listen on all
// interfaces (then put auth / a reverse proxy in front), or use an ssh tunnel
// (ssh -L 4500:localhost:4500 host) for remote access.
const HOST = process.env.HOST || "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.log(`task-dispatcher on http://${HOST}:${PORT}`);
});
