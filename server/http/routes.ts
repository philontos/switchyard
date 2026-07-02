// Every JSON API route, registered onto the shared express app. Pure HTTP glue:
// validate the request, call into a domain module (repo/task/fleet/…), shape the
// response. Bodies are lifted verbatim from index.ts; only this header + the
// registerRoutes() wrapper are new.
import express, { type Express } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn as spawnChild } from "node:child_process";
import { promisify } from "node:util";
import { db, Repo, Task, Host, Provider } from "../core/db.js";
import { renameTask } from "../task/tasks.js";
import { initMirror, fetchMirror, listBranches, removeWorktree, mirrorPath } from "../repo/git.js";
import { scanSkills, defaultSources } from "../skills/skills.js";
import { extForMime, pasteTargetBase, pastedDest, pasteFilename } from "../task/paste.js";
import { listAvailable, installPlugin } from "../skills/plugins.js";
import { startSession, startShellSession, hasSession, killSession, listSessions, pasteText } from "../session/tmux.js";
import { asAgentKind } from "../session/agent.js";
import { syncReposManifest } from "../repo/manifest.js";
import { removeTaskManifest } from "../task/taskmanifest.js";
import { localRunner, runnerFor, SSH_BASE_ARGS, type Runner } from "../fleet/runner.js";
import { aggregateNodes } from "../task/cli.js";
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
  syncTaskManifest, str, providerEnv, checkProvider, slug, SESSION_RE, SSH_BIN,
} from "./context.js";

export function registerRoutes(app: Express) {
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
  // Alternate model backend (optional, node-local, claude-only). A provider is
  // THIS node's own config and only ever applies to tasks THIS node runs on
  // itself — never pushed across the wire, and never for codex (codex switches
  // models via -m, not the ANTHROPIC_* provider env). An unknown id falls back to
  // the default login rather than failing.
  const provider = agentKind === "claude" && host?.kind === "local" && provider_id
    ? (getProvider.get(provider_id) as Provider | undefined)
    : undefined;
  const extraSkills: string[] = Array.isArray(req.body?.extra_skills) ? req.body.extra_skills.map(String) : [];

  // SINK: a bootstrapped remote owns its own tasks — hand the spec to its tdsp and
  // let IT create the task (worktree + session + manifest) on itself. This node
  // does NOT record the task; it surfaces via /api/fleet. A remote that isn't
  // bootstrapped yet falls through to the legacy in-process path below.
  // The agent (claude | codex) DOES travel in the spec — it's a task property, so
  // the node runs the same agent A picked, fully symmetric with a local dispatch.
  // The model backend (provider) does NOT: it's this controller's own node-local
  // config (secrets), never pushed across the wire — the target runs on its own
  // login (so `provider` above is already undefined for any non-local dispatch).
  if (host && host.kind !== "local" && host.tdsp_bin) {
    const spec = { mirror: repo.mirror_path, name: repo.name, git_url: repo.git_url, base: base_branch, title, prompt: prompt || null, skills: extraSkills, agent: agentKind, model: agent_model ?? null };
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
    if (agg) return { ...base, ok: agg.ok, reason: agg.reason, tasks: agg.tasks ?? [], repos: agg.repos ?? [] };
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
  const { mirror, name, git_url, base, title, prompt, agent, agent_model } = req.body ?? {};
  if (!mirror || !base || !title) return res.status(400).json({ error: tr(lang, "task.fieldsRequired") });
  const skills = Array.isArray(req.body?.skills) ? req.body.skills.map(String) : [];
  // agent travels with the task (the node runs claude or codex the same way this
  // box would); the node owns its own login, so no provider crosses the wire.
  const spec = { mirror, name: name || "", git_url: git_url || "", base, title, prompt: prompt || null, skills, agent: asAgentKind(agent), model: agent_model ?? null };
  const b64 = Buffer.from(JSON.stringify(spec)).toString("base64");
  const out = await runTdsp(host, ["create", b64]);
  const result = parseNodeResult(out.stdout);
  if (!result) return res.status(502).json({ error: `node dispatch failed: ${(out.stderr || "no result").slice(0, 300)}` });
  if (result.ok) return res.json({ id: result.id, session: result.session, work_branch: result.workBranch, node: host.id });
  if (result.error === "skillsMissing") return res.status(400).json({ error: tr(lang, "skill.missing", { keys: (result.missing || []).join(", ") }) });
  return res.status(500).json({ error: result.message || result.error });
});

// Stop a task that lives ON a remote node (a fleet task this controller doesn't
// own): drive the node's own tdsp to stop it. The node kills the session, marks
// the task cleaned, and re-manifests — the controller just relays the request.
app.post("/api/nodes/:hostId/tasks/:taskId/stop", async (req, res) => {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.hostId) as Host | undefined;
  if (!host || host.kind === "local") return res.status(404).json({ error: tr(lang, "notFound") });
  if (!host.tdsp_bin) return res.status(409).json({ error: "node not bootstrapped" });
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId)) return res.status(400).json({ error: "invalid task id" });
  const out = await runTdsp(host, ["stop", String(taskId)]);
  const result = parseNodeResult(out.stdout);
  if (!result) return res.status(502).json({ error: `node stop failed: ${(out.stderr || "no result").slice(0, 300)}` });
  if (result.ok) return res.json({ ok: true });
  return res.status(500).json({ error: result.error || "stop failed" });
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
    `git pull --ff-only 2>&1 && npm install --no-audit --no-fund >/dev/null 2>&1; echo "---DONE---"`;
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
  res.json(db.prepare("SELECT * FROM providers ORDER BY id DESC").all());
});

// format + reachability check WITHOUT saving — drives the web's green/red light.
// 200 == reachable; 400 carries the reason so the UI can show it.
app.post("/api/providers/test", async (req, res) => {
  const r = await checkProvider(req.body ?? {});
  if (r.ok) return res.json({ ok: true });
  res.status(400).json({ error: r.error });
});

app.post("/api/providers", async (req, res) => {
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name required" });
  // re-run the same gate on save, so only a reachable provider can ever land in
  // the DB even if a client skips the test button.
  const chk = await checkProvider(req.body ?? {});
  if (!chk.ok) return res.status(400).json({ error: chk.error });
  const info = db.prepare(
    "INSERT INTO providers (name, base_url, auth_token, model, small_fast_model) VALUES (?,?,?,?,?)"
  ).run(String(name).trim(), str(req.body?.base_url), str(req.body?.auth_token), str(req.body?.model), str(req.body?.small_fast_model));
  res.json({ id: Number(info.lastInsertRowid) });
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
