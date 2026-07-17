// Every JSON API route, registered onto the shared express app. Pure HTTP glue:
// validate the request, call into a domain module (repo/task/fleet/…), shape the
// response. Bodies are lifted verbatim from index.ts; only this header + the
// registerRoutes() wrapper are new.
import express, { type Express, type Request, type Response } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn as spawnChild } from "node:child_process";
import { promisify } from "node:util";
import { db, Repo, Task, Host, Provider } from "../core/db.js";
import { renameTask } from "../task/tasks.js";
import { initMirror, fetchMirror, listBranches, removeWorktree, mirrorPath } from "../repo/git.js";
import { findRepoByGitUrl } from "../repo/catalog.js";
import { scanSkills, defaultSources } from "../skills/skills.js";
import { extForMime, pasteTargetBase, pastedDest, pasteFilename, pasteGitExcludePattern, pasteInputText } from "../task/paste.js";
import { listAvailable, installPlugin } from "../skills/plugins.js";
import { startSession, startShellSession, hasSession, killSession, listSessions, pasteText } from "../session/tmux.js";
import { asAgentKind } from "../session/agent.js";
import { readTranscript } from "../session/transcript.js";
import { syncReposManifest } from "../repo/manifest.js";
import { removeTaskManifest } from "../task/taskmanifest.js";
import { localRunner, runnerFor, SSH_BASE_ARGS, type Runner } from "../fleet/runner.js";
import {
  aggregateNodes,
  ARCHIVED_TASK_LIFECYCLE_CAPABILITY,
  isUnknownTdspCommand,
} from "../task/cli.js";
import { fleetTargets, tasksForHost, type FleetTarget } from "../fleet/fleet.js";
import { bootstrapMachine, nodeLadderScript } from "../fleet/bootstrap.js";
import { resolveCwd } from "../fleet/local.js";
import { createRepoTask, type RepoTaskEnv } from "../task/createtask.js";
import { buildRepoTaskEnv } from "../repo/repoenv.js";
import { probeHost } from "../fleet/liveness.js";
import { NS, DATA_DIR, ROOT } from "../core/paths.js";
import { tr, langFromReq } from "../core/i18n.js";
import {
  getRepo, getTask, getHost, getProvider, offline, taskRunner, taskHost,
  syncTaskManifest, providerEnv, checkProvider, slug, SESSION_RE, SSH_BIN,
} from "./context.js";
import { insertCheckedProvider, listProviders } from "../provider/providers.js";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function restartArgs(): string[] {
  try {
    const parsed = JSON.parse(process.env.TDSP_RESTART_ARGS || "[]");
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
  } catch { /* fall through */ }
  return ["serve"];
}

function installedPaths() {
  const root = path.join(os.homedir(), ".task-dispatcher");
  return {
    src: path.join(root, "src"),
    bin: path.join(root, "bin", "tdsp"),
  };
}

async function updateInstalledCode(): Promise<{ ok: true; clone: string; head: string; log: string } | { ok: false; error: string }> {
  const { src } = installedPaths();
  let clone: string;
  try {
    clone = fs.realpathSync(src);
  } catch {
    return { ok: false, error: `no install at ${src} - run \`tdsp install\` from a clone first` };
  }
  try {
    const pull = await localRunner.exec("git", ["-C", clone, "pull", "--ff-only"]);
    await localRunner.exec("npm", ["install", "--no-fund", "--no-audit"], { cwd: clone });
    const head = (await localRunner.exec("git", ["-C", clone, "log", "-1", "--format=%h %s"])).trim();
    return { ok: true, clone, head, log: pull.trim() };
  } catch (e: any) {
    return { ok: false, error: String(e?.stderr || e?.message || e).trim() };
  }
}

function scheduleSelfRestart(args: string[]) {
  const { bin, src } = installedPaths();
  if (!fs.existsSync(bin)) throw new Error(`no tdsp wrapper at ${bin} - run \`tdsp install\` first`);
  const script =
    `sleep 1\n` +
    `cd ${shellQuote(src)} 2>/dev/null || true\n` +
    `exec ${shellQuote(bin)} "$@"`;
  const child = spawnChild("sh", ["-c", script, "tdsp-restart", ...args], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

export function registerRoutes(app: Express) {
// ---------- system ----------
app.post("/api/system/update", async (_req, res) => {
  const updated = await updateInstalledCode();
  if (!updated.ok) return res.status(500).json({ error: updated.error });
  try {
    const args = restartArgs();
    scheduleSelfRestart(args);
    res.json({ ok: true, clone: updated.clone, head: updated.head, log: updated.log, restart: { args } });
    setTimeout(() => process.exit(0), 250).unref();
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- repos ----------
app.get("/api/repos", (_req, res) => {
  res.json(db.prepare("SELECT id,host_id,name,git_url,default_branch,project_path,status,error,created_at FROM repos ORDER BY id DESC").all());
});

app.post("/api/repos", (req, res) => {
  const { name, git_url, token, default_branch, project_path, host_id } = req.body ?? {};
  const lang = langFromReq(req);
  const repoName = String(name || "").trim();
  const gitUrl = String(git_url || "").trim();
  if (!repoName || !gitUrl) return res.status(400).json({ error: tr(lang, "repo.fieldsRequired") });
  // a repo lives ON a machine — default to local, reject offline remotes
  const host = (host_id
    ? getHost.get(host_id)
    : db.prepare("SELECT * FROM hosts WHERE kind='local'").get()) as Host | undefined;
  if (!host) return res.status(404).json({ error: tr(lang, "notFound") });
  if (host.kind !== "local" && host.status !== "online") return res.status(409).json({ error: tr(lang, "host.offline") });
  const runner = runnerFor(host);
  const existing = findRepoByGitUrl(db, host.id, gitUrl);
  if (existing && existing.status !== "error") {
    return res.json({ id: existing.id, existing: true, status: existing.status });
  }

  let id: number;
  let dest: string;
  if (existing) {
    id = existing.id;
    dest = existing.mirror_path || mirrorPath(runner.dataDir, id, repoName);
    db.prepare(
      "UPDATE repos SET name=?,git_url=?,token=?,default_branch=?,project_path=?,mirror_path=?,status='cloning',error=NULL WHERE id=?"
    ).run(repoName, gitUrl, token || null, default_branch || "main", project_path || null, dest, id);
  } else {
    const info = db.prepare(
      "INSERT INTO repos (host_id, name, git_url, token, default_branch, project_path, status) VALUES (?,?,?,?,?,?,?)"
    ).run(host.id, repoName, gitUrl, token || null, default_branch || "main", project_path || null, "cloning");
    id = Number(info.lastInsertRowid);
    dest = mirrorPath(runner.dataDir, id, repoName);
    db.prepare("UPDATE repos SET mirror_path = ? WHERE id = ?").run(dest, id);
  }
  syncReposManifest();

  // register in background: init bare repo + validate connectivity (no download)
  (async () => {
    try {
      await initMirror(runner, gitUrl, token || null, dest);
      db.prepare("UPDATE repos SET status='ready', error=NULL WHERE id=?").run(id);
    } catch (e: any) {
      db.prepare("UPDATE repos SET status='error', error=? WHERE id=?").run(String(e.message || e), id);
    }
  })();

  res.json({ id, existing: !!existing, retrying: !!existing, status: "cloning" });
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
  const { repo_id, base_branch, title, prompt, provider_id, agent, agent_model } = req.body ?? {};
  const lang = langFromReq(req);
  if (!repo_id || !base_branch || !title) {
    return res.status(400).json({ error: tr(lang, "task.fieldsRequired") });
  }
  const repo = getRepo.get(repo_id) as Repo | undefined;
  if (!repo || !repo.mirror_path) return res.status(404).json({ error: tr(lang, "repo.notFound") });
  if (repo.status !== "ready") return res.status(409).json({ error: tr(lang, "repo.status", { status: repo.status }) });
  const host = getHost.get(repo.host_id) as Host | undefined;
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  // Which coding-agent CLI runs the task (claude default | codex). codex is a
  // local-node feature in this version, so a codex dispatch only travels the
  // in-process path below (never the remote-node branch).
  const agentKind = asAgentKind(agent);
  // Alternate model backend (optional, claude-only). For local dispatch the id is
  // resolved here; for remote dispatch it is already an id from the target node's
  // provider catalog and is only relayed in the tdsp create spec.
  const provider = agentKind === "claude" && (!host || host.kind === "local") && provider_id
    ? (getProvider.get(provider_id) as Provider | undefined)
    : undefined;
  const extraSkills: string[] = Array.isArray(req.body?.extra_skills) ? req.body.extra_skills.map(String) : [];

  // SINK: a bootstrapped remote owns its own tasks — hand the spec to its tdsp and
  // let IT create the task (worktree + session + manifest) on itself. This node
  // does NOT record the task; it surfaces via /api/fleet. A remote that isn't
  // bootstrapped yet falls through to the legacy in-process path below.
  // The agent and provider_id both travel as target-node task properties. The
  // provider secret itself does not cross here: the id refers to a row already
  // stored on the node that will run the task.
  if (host && host.kind !== "local" && host.tdsp_bin) {
    const spec = {
      mirror: repo.mirror_path,
      name: repo.name,
      git_url: repo.git_url,
      base: base_branch,
      title,
      prompt: prompt || null,
      skills: extraSkills,
      agent: agentKind,
      model: agent_model ?? null,
      provider_id: agentKind === "claude" && provider_id ? Number(provider_id) : null,
    };
    const b64 = Buffer.from(JSON.stringify(spec)).toString("base64");
    const out = await runTdsp(host, ["create", b64]);
    const result = parseNodeResult(out.stdout);
    if (!result) return res.status(502).json({ error: `node dispatch failed: ${(out.stderr || "no result").slice(0, 300)}` });
    if (result.ok) return res.json({ id: result.id, session: result.session, work_branch: result.workBranch, node: host.id });
    if (result.error === "skillsMissing") return res.status(400).json({ error: tr(lang, "skill.missing", { keys: (result.missing || []).join(", ") }) });
    return res.status(500).json({ error: result.message || result.error });
  }

  // local host, or a remote not yet bootstrapped: dispatch in-process on its Runner.
  // The provider (if any) is recorded on the task and injected as ANTHROPIC_* env
  // when claude launches; resume re-injects it from the recorded provider_id.
  const r = await createRepoTask(
    repoTaskEnvFor(runnerFor(host as Host)),
    { id: repo.id, name: repo.name, mirror_path: repo.mirror_path },
    { baseBranch: base_branch, title, prompt, extraSkills, providerId: provider ? provider.id : null, env: providerEnv(provider), agent: agentKind, model: agent_model ?? null },
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

async function pasteImageIntoTask(req: Request, res: Response, task: Task, runner: Runner) {
  const lang = langFromReq(req);
  const ext = extForMime(req.headers["content-type"]);
  if (!ext) return res.status(400).json({ error: tr(lang, "paste.badType") });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: tr(lang, "paste.empty") });
  const base = pasteTargetBase(task);
  if (!base) return res.status(409).json({ error: tr(lang, "paste.noTarget") });

  const agent = asAgentKind(task.agent);
  const dest = pastedDest(base, pasteFilename(Date.now(), ext), agent);
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
  const excludePattern = pasteGitExcludePattern(agent);
  await runner.exec("sh", ["-c",
    `cd ${JSON.stringify(base)} && p=$(git rev-parse --git-path info/exclude 2>/dev/null) && [ -n "$p" ] && ` +
    `{ grep -qxF ${JSON.stringify(excludePattern)} "$p" 2>/dev/null || printf '%s\\n' ${JSON.stringify(excludePattern)} >> "$p"; }`,
  ]).catch(() => {});
  if (task.session) await pasteText(runner, task.session, pasteInputText(agent, dest)).catch(() => {});
  res.json({ ok: true, path: dest });
}

// paste a screenshot into a task's agent: receive the raw image bytes, land
// them ON the task's machine (worktree for a repo task, cwd for a local task)
// via the Runner, then bracketed-paste the adapter's input text into the
// session. Identical local + remote (Runner).
app.post("/api/tasks/:id/paste-image", express.raw({ type: "image/*", limit: "25mb" }), async (req, res) => {
  const lang = langFromReq(req);
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: tr(lang, "notFound") });
  if (offline(taskHost(task))) return res.status(409).json({ error: tr(lang, "host.offline") });
  return pasteImageIntoTask(req, res, task, taskRunner(task));
});

// Read a task's agent conversation as normalized entries — the data behind the mobile
// "阅读 / Reading" view. Incremental: pass the previous ?since byte cursor + ?source id
// to get only what's new; a changed source (e.g. /clear started a fresh Claude session)
// makes the client reload from the top. Read-only + best-effort: a task with no
// transcript yet, or an offline remote, just returns an empty stream (never errors).
app.get("/api/tasks/:id/transcript", async (req, res) => {
  const lang = langFromReq(req);
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: tr(lang, "notFound") });
  if (offline(taskHost(task))) {
    return res.json({ agent: asAgentKind(task.agent), source: null, entries: [], cursor: 0 });
  }
  const since = Math.max(0, parseInt(String(req.query.since ?? "0"), 10) || 0);
  const source = req.query.source ? String(req.query.source) : null;
  try {
    res.json(await readTranscript(taskRunner(task), task, since, source));
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
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
    // resume on the SAME agent + model/backend the task was created with: claude
    // re-injects its provider env; codex re-runs `codex resume --last` with its
    // recorded model. providerEnv is empty for a codex task (provider_id is NULL).
    const provider = task.provider_id ? (getProvider.get(task.provider_id) as Provider | undefined) : undefined;
    if (!alreadyAlive) await startSession(runner, task.session, task.worktree_path, null, {
      continue: true, env: providerEnv(provider), agent: asAgentKind(task.agent), model: task.agent_model,
    });
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
    if (agg) {
      const capabilities = agg.capabilities ?? [];
      return {
        ...base,
        ok: agg.ok,
        reason: agg.reason,
        schema_version: agg.schema_version,
        capabilities,
        needsUpdate: agg.ok && !capabilities.includes(ARCHIVED_TASK_LIFECYCLE_CAPABILITY),
        tasks: agg.tasks ?? [],
        repos: agg.repos ?? [],
      };
    }
    return { ...base, ok: false, reason: "notBootstrapped" as const };
  });
  res.json({ schema_version: 1, nodes });
});

// Live branches for one of a remote node's repos (its mirror lives on the node, so
// only the node can list them). Lets the dispatch modal offer the node repo's real
// branches instead of just its default. `mirror` is the node repo's mirror path.
app.get("/api/nodes/:hostId/branches", async (req, res) => {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.hostId) as Host | undefined;
  if (!host || host.kind === "local") return res.status(404).json({ error: tr(lang, "notFound") });
  if (!host.tdsp_bin) return res.status(409).json({ error: "node not bootstrapped" });
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const mirror = String(req.query.mirror ?? "");
  if (!mirror) return res.status(400).json({ error: "mirror required" });
  const out = await runTdsp(host, ["branches", mirror]);
  const result = parseNodeResult(out.stdout);
  if (!result || !result.ok) return res.status(502).json({ error: result?.error || `node branches failed: ${(out.stderr || "no result").slice(0, 200)}` });
  res.json(result.branches ?? []);
});

// Dispatch a repo task to a remote node using the NODE'S OWN repo (surfaced via
// the fleet) — no re-registration on this controller, no duplicate mirror. The
// node registers the repo by mirror path (find-or-create), builds the worktree
// from its own mirror, and owns the task. This controller only relays the spec.
app.post("/api/nodes/:hostId/tasks", async (req, res) => {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.hostId) as Host | undefined;
  if (!host || host.kind === "local") return res.status(404).json({ error: tr(lang, "notFound") });
  if (!host.tdsp_bin) return res.status(409).json({ error: "node not bootstrapped" });
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const { mirror, name, git_url, base, title, prompt, agent, provider_id } = req.body ?? {};
  if (!mirror || !base || !title) return res.status(400).json({ error: tr(lang, "task.fieldsRequired") });
  const skills = Array.isArray(req.body?.skills) ? req.body.skills.map(String) : [];
  const agentKind = asAgentKind(agent);
  const spec = {
    mirror,
    name: name || "",
    git_url: git_url || "",
    base,
    title,
    prompt: prompt || null,
    skills,
    agent: agentKind,
    model: req.body?.model ?? req.body?.agent_model ?? null,
    provider_id: agentKind === "claude" && provider_id ? Number(provider_id) : null,
  };
  const b64 = Buffer.from(JSON.stringify(spec)).toString("base64");
  const out = await runTdsp(host, ["create", b64]);
  const result = parseNodeResult(out.stdout);
  if (!result) return res.status(502).json({ error: `node dispatch failed: ${(out.stderr || "no result").slice(0, 300)}` });
  if (result.ok) return res.json({ id: result.id, session: result.session, work_branch: result.workBranch, node: host.id });
  if (result.error === "skillsMissing") return res.status(400).json({ error: tr(lang, "skill.missing", { keys: (result.missing || []).join(", ") }) });
  return res.status(500).json({ error: result.message || result.error });
});

function b64Json(body: unknown) {
  return Buffer.from(JSON.stringify(body ?? {})).toString("base64");
}

async function runNodeJson(host: Host, args: string[]) {
  const out = await runTdsp(host, args);
  return parseNodeResult(out.stdout);
}

// Paste into a task owned by a remote node. The pane id in the browser is
// controller-local ("n<host>:<task>"), so this route first asks the node for its
// own task row, then reuses the same paste adapter against that node's Runner.
app.post("/api/nodes/:hostId/tasks/:taskId/paste-image", express.raw({ type: "image/*", limit: "25mb" }), async (req, res) => {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.hostId) as Host | undefined;
  if (!host || host.kind === "local") return res.status(404).json({ error: tr(lang, "notFound") });
  if (!host.tdsp_bin) return res.status(409).json({ error: "node not bootstrapped" });
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });

  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId)) return res.status(400).json({ error: "invalid task id" });

  const payload = await runNodeJson(host, ["list", "--json"]);
  const task = Array.isArray(payload?.tasks)
    ? payload.tasks.find((t: any) => Number(t?.id) === taskId)
    : null;
  if (!task) return res.status(404).json({ error: tr(lang, "notFound") });

  return pasteImageIntoTask(req, res, task as Task, runnerFor(host));
});

// Provider catalog on a remote node. The controller only relays these calls; the
// provider rows and tokens live in the same DB as the tasks that will use them.
app.get("/api/nodes/:hostId/providers", async (req, res) => {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.hostId) as Host | undefined;
  if (!host || host.kind === "local") return res.status(404).json({ error: tr(lang, "notFound") });
  if (!host.tdsp_bin) return res.status(409).json({ error: "node not bootstrapped" });
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const result = await runNodeJson(host, ["providers-list"]);
  if (!result || !result.ok) return res.status(502).json({ error: result?.error || "node providers failed" });
  res.json(result.providers ?? []);
});

app.post("/api/nodes/:hostId/providers/test", async (req, res) => {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.hostId) as Host | undefined;
  if (!host || host.kind === "local") return res.status(404).json({ error: tr(lang, "notFound") });
  if (!host.tdsp_bin) return res.status(409).json({ error: "node not bootstrapped" });
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const result = await runNodeJson(host, ["providers-test", b64Json(req.body ?? {})]);
  if (result?.ok) return res.json({ ok: true });
  res.status(400).json({ error: result?.error || "node provider test failed" });
});

app.post("/api/nodes/:hostId/providers", async (req, res) => {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.hostId) as Host | undefined;
  if (!host || host.kind === "local") return res.status(404).json({ error: tr(lang, "notFound") });
  if (!host.tdsp_bin) return res.status(409).json({ error: "node not bootstrapped" });
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const result = await runNodeJson(host, ["providers-create", b64Json(req.body ?? {})]);
  if (result?.ok) return res.json({ id: result.id });
  res.status(400).json({ error: result?.error || "node provider save failed" });
});

app.delete("/api/nodes/:hostId/providers/:id", async (req, res) => {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.hostId) as Host | undefined;
  if (!host || host.kind === "local") return res.status(404).json({ error: tr(lang, "notFound") });
  if (!host.tdsp_bin) return res.status(409).json({ error: "node not bootstrapped" });
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const result = await runNodeJson(host, ["providers-delete", String(req.params.id)]);
  if (result?.ok) return res.json({ ok: true });
  res.status(400).json({ error: result?.error || "node provider delete failed" });
});

// Relay a lifecycle verb to the node that owns the task. The controller never
// mutates fleet task rows itself: the node owns their DB, sessions, worktrees,
// provider configuration and manifests.
async function relayNodeTaskAction(req: Request, res: Response, verb: "stop" | "resume" | "cleanup" | "delete-task") {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.hostId) as Host | undefined;
  if (!host || host.kind === "local") return res.status(404).json({ error: tr(lang, "notFound") });
  if (!host.tdsp_bin) return res.status(409).json({ error: "node not bootstrapped" });
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId)) return res.status(400).json({ error: "invalid task id" });
  const out = await runTdsp(host, [verb, String(taskId)]);
  const result = parseNodeResult(out.stdout);
  if (!result) {
    if (isUnknownTdspCommand(`${out.stderr}\n${out.stdout}`, verb)) {
      return res.status(409).json({
        code: "nodeUpdateRequired",
        error: tr(lang, "host.nodeUpdateRequired"),
      });
    }
    return res.status(502).json({ error: `node ${verb} failed: ${(out.stderr || "no result").slice(0, 300)}` });
  }
  if (result.ok) return res.json(result);

  const known: Record<string, string> = {
    notFound: tr(lang, "notFound"),
    notResumable: tr(lang, "task.notResumable"),
    worktreeGone: tr(lang, "task.worktreeGone"),
    worktreeExists: tr(lang, "task.worktreeExists"),
  };
  const status = result.error === "notFound" ? 404
    : ["notResumable", "worktreeGone", "worktreeExists"].includes(result.error) ? 409
    : 500;
  return res.status(status).json({ error: result.message || known[result.error] || result.error || `${verb} failed` });
}

// Stop a live task, keeping its worktree in the node's archived list.
app.post("/api/nodes/:hostId/tasks/:taskId/stop", (req, res) => {
  return relayNodeTaskAction(req, res, "stop");
});

// Archived-task operations, symmetric with the controller-local task routes.
app.post("/api/nodes/:hostId/tasks/:taskId/resume", (req, res) => {
  return relayNodeTaskAction(req, res, "resume");
});

app.post("/api/nodes/:hostId/tasks/:taskId/cleanup", (req, res) => {
  return relayNodeTaskAction(req, res, "cleanup");
});

app.delete("/api/nodes/:hostId/tasks/:taskId", (req, res) => {
  return relayNodeTaskAction(req, res, "delete-task");
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

  // the repo the target clones from if it has no code yet = THIS controller's own
  // git origin. So a fresh machine gets the same switchyard A is running.
  const originUrl = (await localRunner.exec("git", ["-C", ROOT, "remote", "get-url", "origin"]).catch(() => "")).trim();
  if (!originUrl) return res.status(500).json({ error: "couldn't read this controller's git origin to clone from" });

  try {
    const result = await bootstrapMachine({
      home,
      originUrl,
      run: sshRun(host.target),
      override: typeof req.body?.nodeOverride === "string" && req.body.nodeOverride.trim() ? req.body.nodeOverride.trim() : undefined,
    });
    if (!result.ok) return res.status(500).json({ error: result.error });
    db.prepare("UPDATE hosts SET tdsp_bin=? WHERE id=?").run(result.binPath, host.id);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Update a bootstrapped node's code to the latest, idempotently: `git pull` in its
// canonical src pointer (which transparently follows a symlink to the machine's
// own clone), then npm install. The node's tdsp picks up the new code on its very
// next invocation — no restart needed for controller-driven commands.
app.post("/api/hosts/:id/update", async (req, res) => {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.id) as Host | undefined;
  if (!host || host.kind === "local") return res.status(404).json({ error: tr(lang, "notFound") });
  if (!host.tdsp_bin) return res.status(409).json({ error: "node not bootstrapped" });
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const home = (await runnerFor(host).exec("sh", ["-c", 'echo "$HOME"']).catch(() => "")).trim();
  if (!home) return res.status(502).json({ error: "could not resolve the machine's home dir" });
  const src = `${home}/.task-dispatcher/src`;
  // git on the bare ssh PATH (homebrew); node via the discovery ladder for npm
  const script =
    `export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH\n${nodeLadderScript()}\n` +
    `cd ${JSON.stringify(src)} || { echo "no src at ${src}"; exit 1; }\n` +
    `git pull --ff-only 2>&1 || exit 1\n` +
    `npm install --no-audit --no-fund >/dev/null 2>&1 || { echo "npm install failed"; exit 1; }\n` +
    `echo "---DONE---"`;
  const out = await sshRun(host.target)(script);
  const log = out.stdout.split("---DONE---")[0].trim();
  if (!out.ok || /no src at/.test(out.stdout)) return res.status(500).json({ error: log || "update failed" });
  res.json({ ok: true, log });
});

app.delete("/api/hosts/:id", (req, res) => {
  const host = getHost.get(req.params.id) as Host | undefined;
  if (host?.kind === "local") return res.status(409).json({ error: "cannot delete the local machine" });
  const n = (db.prepare("SELECT count(*) AS c FROM repos WHERE host_id=?").get(req.params.id) as { c: number }).c;
  if (n > 0) return res.status(409).json({ error: "remove this machine's repos first" });
  db.prepare("DELETE FROM hosts WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- providers (alternate model backends for claude) ----------
app.get("/api/providers", (_req, res) => {
  res.json(listProviders(db));
});

// format + reachability check WITHOUT saving — drives the web's green/red light.
// 200 == reachable; 400 carries the reason so the UI can show it.
app.post("/api/providers/test", async (req, res) => {
  const r = await checkProvider(req.body ?? {});
  if (r.ok) return res.json({ ok: true });
  res.status(400).json({ error: r.error });
});

app.post("/api/providers", async (req, res) => {
  // re-run the same gate on save, so only a reachable provider can ever land in
  // the DB even if a client skips the test button.
  const r = await insertCheckedProvider(db, req.body ?? {});
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ id: r.id });
});

app.delete("/api/providers/:id", (req, res) => {
  // tasks that used this provider fall back to the default claude login on their
  // next resume (provider_id -> NULL), rather than dangling at a gone row.
  db.prepare("UPDATE tasks SET provider_id=NULL WHERE provider_id=?").run(req.params.id);
  db.prepare("DELETE FROM providers WHERE id=?").run(req.params.id);
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

}
