// Every JSON API route, registered onto the shared express app. Pure HTTP glue:
// validate the request, call into a domain module (repo/task/fleet/…), shape the
// response. Bodies are lifted verbatim from index.ts; only this header + the
// registerRoutes() wrapper are new.
import express, { type Express, type Request, type Response } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { db, Repo, Task, Host, Provider } from "../core/db.js";
import { renameTask } from "../task/tasks.js";
import { removeWorktree } from "../repo/git.js";
import { scanSkills, defaultSources } from "../skills/skills.js";
import { listAvailable, installPlugin } from "../skills/plugins.js";
import { startSession, startShellSession, hasSession, killSession, listSessions } from "../session/tmux.js";
import { asAgentKind } from "../session/agent.js";
import { readTranscript } from "../session/transcript.js";
import { syncReposManifest } from "../repo/manifest.js";
import { removeTaskManifest } from "../task/taskmanifest.js";
import { localRunner, RemoteRunner, transportRunnerFor, SSH_BASE_ARGS } from "../fleet/runner.js";
import {
  aggregateNodes,
  NODE_CONTROL_CAPABILITY,
  isUnknownTdspCommand,
  taskListPayload,
} from "../task/cli.js";
import { fleetTargets, type FleetTarget } from "../fleet/fleet.js";
import { bootstrapMachine, validProfileName } from "../fleet/bootstrap.js";
import { createLocalTask, createRepoTask, type RepoTaskEnv } from "../task/createtask.js";
import { buildRepoTaskEnv } from "../repo/repoenv.js";
import { probeHost } from "../fleet/liveness.js";
import { NS, DATA_DIR, ROOT } from "../core/paths.js";
import { tr, langFromReq } from "../core/i18n.js";
import {
  getRepo, getTask, getHost, getProvider, offline,
  syncTaskManifest, providerEnv, checkProvider, SESSION_RE, SSH_BIN,
} from "./context.js";
import {
  clearProviderFromOwnedTasks,
  listOwnedRepos,
  listOwnedTasks,
  localHostId,
} from "../core/ownership.js";
import { branchesForOwnedRepo, deleteOwnedRepo, fetchOwnedRepo, registerOwnedRepo, type OwnedRepoEnv } from "../repo/owned.js";
import { pasteImageIntoOwnedTask } from "../task/paste-service.js";
import { parseNodeJson, runNodeCommand } from "../fleet/nodeclient.js";
import { insertCheckedProvider, providerSummaries, providersForList } from "../provider/providers.js";
import {
  codeErrorStatus,
  codeResult,
  inspectRepoCode,
  inspectTaskCode,
  isCodeInspectRequest,
  type CodeInspectRequest,
} from "../codeview/codeview.js";
import { tailscaleStatus } from "../network/tailscale.js";
import {
  descriptorMatchesPeer,
  discoveryPorts,
  isNodeDescriptor,
  localNodeDescriptor,
  probeSwitchyardPeer,
  requestPeerJson,
  sameLogin,
  trustedServeIdentity,
  upsertTailscaleHost,
} from "../network/peering.js";
import { authorizeSwitchyardKey, removeSwitchyardKey } from "../network/ssh-identity.js";

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

const ownedRepoEnv: OwnedRepoEnv = {
  db,
  runner: localRunner,
  syncRepos: syncReposManifest,
  removeTaskManifest: (id) => removeTaskManifest(DATA_DIR, id),
  killSession: (session) => killSession(localRunner, session),
};

function sendRepoFailure(req: Request, res: Response, result: any) {
  const lang = langFromReq(req);
  if (result?.error === "fieldsRequired") return res.status(400).json({ error: tr(lang, "repo.fieldsRequired") });
  if (result?.error === "notFound") return res.status(404).json({ error: tr(lang, "notFound") });
  if (result?.error === "notReady") return res.status(409).json({ error: tr(lang, "repo.status", { status: result.message || "unknown" }) });
  if (result?.error === "hasLiveTasks") {
    return res.status(409).json({
      error: tr(lang, "repo.hasLiveTasks", { count: result.liveCount || 0 }),
      liveCount: result.liveCount || 0,
    });
  }
  return res.status(500).json({ error: result?.message || result?.error || "repository operation failed" });
}

function sendPasteFailure(req: Request, res: Response, result: any) {
  const lang = langFromReq(req);
  if (result?.error === "badType") return res.status(400).json({ error: tr(lang, "paste.badType") });
  if (result?.error === "empty") return res.status(400).json({ error: tr(lang, "paste.empty") });
  if (result?.error === "notFound") return res.status(404).json({ error: tr(lang, "notFound") });
  if (result?.error === "noTarget") return res.status(409).json({ error: tr(lang, "paste.noTarget") });
  return res.status(500).json({ error: result?.message || result?.error || "image paste failed" });
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

// ---------- Tailscale node discovery + SSH pairing ----------
function publicHost(host: Host) {
  const { data_dir: _dataDir, tdsp_bin: _tdspBin, ...safe } = host;
  return safe;
}

async function trustedPeerRequest(req: Request, res: Response) {
  if (process.env.TDSP_TAILSCALE_SERVE !== "1") {
    res.status(404).json({ error: "Tailscale node discovery is not enabled" });
    return null;
  }
  const status = await tailscaleStatus();
  const login = req.get("tailscale-user-login") || undefined;
  if (!trustedServeIdentity(req.socket.remoteAddress, login, status)) {
    res.status(403).json({ error: "the request is not from this node's Tailscale user" });
    return null;
  }
  return status;
}

// Minimal same-user descriptor. This endpoint is available only through a
// loopback-backed Tailscale Serve route; spoofable direct/LAN header traffic is
// rejected by trustedServeIdentity.
app.get("/.well-known/switchyard", async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const status = await trustedPeerRequest(req, res);
  if (!status) return;
  try {
    res.json(await localNodeDescriptor(status));
  } catch (error: any) {
    res.status(503).json({ error: String(error?.message || error) });
  }
});

// The accepting half of a bilateral connection. The requester's Tailscale
// identity is verified by Serve, then bound to the descriptor Tailscale already
// reports for that peer before its key can enter authorized_keys.
app.post("/api/network/handshake", async (req, res) => {
  res.setHeader("cache-control", "no-store");
  const status = await trustedPeerRequest(req, res);
  if (!status) return;
  const descriptor = req.body;
  if (!isNodeDescriptor(descriptor)) {
    return res.status(400).json({ error: "invalid Switchyard node descriptor" });
  }
  if (descriptor.instance_id === NS) {
    return res.status(409).json({ error: "cannot connect a Switchyard instance to itself" });
  }
  const peer = status.peers.find((candidate) => candidate.id === descriptor.tailscale.id);
  if (!peer || !peer.online || !status.self?.loginName
      || !descriptorMatchesPeer(descriptor, peer, status.self.loginName)) {
    return res.status(403).json({ error: "the descriptor does not match the authenticated Tailscale peer" });
  }
  try {
    authorizeSwitchyardKey(descriptor.ssh.public_key, descriptor.instance_id);
    const host = upsertTailscaleHost(db, descriptor);
    // SSH readiness is deliberately a separate state. Key exchange/registration
    // succeeds even when Remote Login is still disabled; the onboarding state
    // machine can guide that one OS step later.
    void probeHost(host).catch(() => {});
    res.json({ ok: true, node: await localNodeDescriptor(status), host: publicHost(host) });
  } catch (error: any) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

// Scan only online devices owned by the same Tailscale login. Non-Switchyard
// devices remain visible as unavailable candidates so the future onboarding UI
// has an honest place to offer installation.
app.get("/api/network/discovery", async (_req, res) => {
  res.setHeader("cache-control", "no-store");
  if (process.env.TDSP_TAILSCALE_SERVE !== "1") {
    return res.status(409).json({ code: "tailscaleServeRequired", error: "start Switchyard with tdsp serve --tailscale" });
  }
  const status = await tailscaleStatus();
  const login = status.self?.loginName;
  if (status.state !== "running" || !login) {
    return res.status(409).json({ code: "tailscaleRequired", error: status.error || "Tailscale is not connected" });
  }
  const candidates = status.peers.filter((peer) => peer.online && sameLogin(peer.loginName, login));
  const known = db.prepare("SELECT * FROM hosts WHERE kind!='local'").all() as Host[];
  const ports = discoveryPorts();
  const peers = await Promise.all(candidates.map(async (peer) => {
    const probe = await probeSwitchyardPeer(peer, ports);
    const valid = !!probe.descriptor && descriptorMatchesPeer(probe.descriptor, peer, login);
    const descriptor = valid ? probe.descriptor : null;
    const connected = known.some((host) =>
      host.tailscale_id === peer.id || (!!descriptor && host.node_id === descriptor.instance_id),
    );
    return {
      id: peer.id,
      name: peer.hostName || peer.dnsName,
      dns_name: peer.dnsName,
      ip: peer.ips.find((ip) => ip.startsWith("100.")) || peer.ips[0] || null,
      os: peer.os,
      connection: peer.connection,
      switchyard: !!descriptor,
      compatible: !!descriptor,
      connected,
      serve_port: descriptor?.tailscale.serve_port ?? probe.port,
      error: descriptor ? null : (valid ? null : probe.error || "Switchyard was not found"),
    };
  }));
  res.json({
    ok: true,
    self: {
      id: status.self?.id,
      name: status.self?.hostName,
      login_name: login,
    },
    peers,
  });
});

// One click on A: re-resolve B from the live Tailscale map, have B record A and
// authorize A's dedicated key, then mirror B's returned descriptor into A.
app.post("/api/network/connect", async (req, res) => {
  res.setHeader("cache-control", "no-store");
  if (process.env.TDSP_TAILSCALE_SERVE !== "1") {
    return res.status(409).json({ code: "tailscaleServeRequired", error: "start Switchyard with tdsp serve --tailscale" });
  }
  const peerId = typeof req.body?.peer_id === "string" ? req.body.peer_id : "";
  if (!peerId) return res.status(400).json({ error: "peer_id required" });
  const status = await tailscaleStatus();
  const login = status.self?.loginName;
  const peer = status.peers.find((candidate) => candidate.id === peerId);
  if (status.state !== "running" || !login || !peer || !peer.online || !sameLogin(peer.loginName, login)) {
    return res.status(404).json({ error: "the Tailscale peer is not online under this user" });
  }
  try {
    const probe = await probeSwitchyardPeer(peer, discoveryPorts());
    if (!probe.ok || !probe.descriptor || !probe.port
        || !descriptorMatchesPeer(probe.descriptor, peer, login)) {
      return res.status(409).json({ code: "switchyardUnavailable", error: probe.error || "Switchyard is not available on this peer" });
    }
    if (probe.descriptor.instance_id === NS) {
      return res.status(409).json({ error: "cannot connect a Switchyard instance to itself" });
    }
    const local = await localNodeDescriptor(status);
    const handshake = await requestPeerJson(
      peer,
      probe.port,
      "/api/network/handshake",
      "POST",
      local,
    );
    const remote = handshake.body?.node;
    if (!handshake.ok || !isNodeDescriptor(remote)
        || !descriptorMatchesPeer(remote, peer, login)) {
      return res.status(502).json({ error: handshake.error || "peer handshake failed" });
    }
    authorizeSwitchyardKey(remote.ssh.public_key, remote.instance_id);
    const host = upsertTailscaleHost(db, remote);
    void probeHost(host).catch(() => {});
    res.json({ ok: true, host: publicHost(host), bilateral: true, ssh_ready: host.ssh_ready });
  } catch (error: any) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

// ---------- repos ----------
app.get("/api/repos", (_req, res) => {
  res.json(listOwnedRepos(db).map(({ token: _token, mirror_path: _mirror, ...repo }) => repo));
});

app.post("/api/repos", async (req, res) => {
  const requestedHost = req.body?.host_id;
  if (requestedHost != null && Number(requestedHost) !== localHostId(db)) {
    return res.status(409).json({ error: "remote repositories must be registered through the target node" });
  }
  const result = await registerOwnedRepo(ownedRepoEnv, req.body ?? {});
  if (!result.ok) return sendRepoFailure(req, res, result);
  res.json(result);
});

app.post("/api/repos/:id/fetch", async (req, res) => {
  const result = await fetchOwnedRepo(ownedRepoEnv, Number(req.params.id));
  if (!result.ok) return sendRepoFailure(req, res, result);
  res.json({ ok: true });
});

app.get("/api/repos/:id/branches", async (req, res) => {
  const result = await branchesForOwnedRepo(ownedRepoEnv, Number(req.params.id));
  if (!result.ok) return sendRepoFailure(req, res, result);
  res.json(result.branches);
});

// Delete a repo and everything bound to it — so the per-machine task view never
// strands an invisible orphan. Live tasks (status != cleaned) block a plain
// delete; ?force=1 tears them down too. Archived tasks (cleaned, worktree kept
// or not) are always cleaned up with the repo — no unknown worktree left behind.
app.delete("/api/repos/:id", async (req, res) => {
  const force = req.query.force === "1" || req.query.force === "true";
  const result = await deleteOwnedRepo(ownedRepoEnv, Number(req.params.id), force);
  if (!result.ok) return sendRepoFailure(req, res, result);
  res.json({ ok: true });
});

// ---------- tasks ----------
app.get("/api/tasks", async (_req, res) => {
  const tasks = listOwnedTasks(db);
  const withLive = await Promise.all(
    tasks.map(async (t) => {
      const runner = localRunner;
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
        // on this owning node's local filesystem. No worktree → never.
        waiting: t.status !== "cleaned" && hasWt
          && (await runner.exists(path.join(t.worktree_path, ".claude/waiting")).catch(() => false)),
      };
    })
  );
  res.json(withLive);
});

// Bind createRepoTask to this owning node's local runner and manifest writer.
function repoTaskEnvFor(): RepoTaskEnv {
  return buildRepoTaskEnv({ db, ns: NS, runner: localRunner, writeManifest: (tid) => syncTaskManifest(tid) });
}

app.post("/api/tasks", async (req, res) => {
  const { repo_id, base_branch, title, prompt, provider_id, agent, agent_model } = req.body ?? {};
  const lang = langFromReq(req);
  const requestedHost = req.body?.host_id;
  if (requestedHost != null && Number(requestedHost) !== localHostId(db)) {
    return res.status(409).json({ error: "remote tasks must be created through the target node" });
  }
  if (!repo_id || !base_branch || !title) {
    return res.status(400).json({ error: tr(lang, "task.fieldsRequired") });
  }
  const repo = getRepo.get(repo_id) as Repo | undefined;
  if (!repo || !repo.mirror_path) return res.status(404).json({ error: tr(lang, "repo.notFound") });
  if (repo.status !== "ready") return res.status(409).json({ error: tr(lang, "repo.status", { status: repo.status }) });
  const agentKind = asAgentKind(agent);
  // Alternate model backend (optional, claude-only), resolved only from this
  // node's provider catalog.
  const provider = agentKind === "claude" && provider_id
    ? (getProvider.get(provider_id) as Provider | undefined)
    : undefined;
  const extraSkills: string[] = Array.isArray(req.body?.extra_skills) ? req.body.extra_skills.map(String) : [];
  const r = await createRepoTask(
    repoTaskEnvFor(),
    { id: repo.id, name: repo.name, mirror_path: repo.mirror_path },
    { baseBranch: base_branch, title, prompt, extraSkills, providerId: provider ? provider.id : null, env: providerEnv(provider), agent: agentKind, model: agent_model ?? null },
  );
  if (r.ok) return res.json({ id: r.id, session: r.session, work_branch: r.workBranch });
  if (r.error === "skillsMissing") return res.status(400).json({ error: tr(lang, "skill.missing", { keys: r.missing.join(", ") }) });
  return res.status(500).json({ error: r.message });
});

// repo-less shell task: skip the mirror/worktree/skills machinery and just open a
// bare tmux shell in a plain dir (default this node's home). A remote controller
// must invoke the target node's create-local verb instead of selecting host_id
// here. Stored with kind='local', repo_id=0 and empty branch/worktree columns.
app.post("/api/tasks/local", async (req, res) => {
  const lang = langFromReq(req);
  const requestedHost = req.body?.host_id;
  if (requestedHost != null && Number(requestedHost) !== localHostId(db)) {
    return res.status(409).json({ error: "remote shells must be created through the target node" });
  }
  const result = await createLocalTask({
    db,
    home: os.homedir(),
    ns: NS,
    dataDir: DATA_DIR,
    cwdExists: (cwd) => localRunner.exists(cwd),
    startShell: (session, cwd) => startShellSession(localRunner, session, cwd),
  }, { cwd: req.body?.cwd ?? null, title: req.body?.title ?? null });
  if (result.ok) return res.json(result);
  if (result.error === "cwdMissing") return res.status(400).json({ error: tr(lang, "task.cwdMissing", { cwd: String(req.body?.cwd ?? "") }) });
  res.status(500).json({ error: result.message || result.error });
});

// Local tasks are handled by this node's own task service.
app.post("/api/tasks/:id/paste-image", express.raw({ type: "image/*", limit: "25mb" }), async (req, res) => {
  const result = await pasteImageIntoOwnedTask(
    db, localRunner, NS, Number(req.params.id), req.headers["content-type"], req.body as Buffer,
  );
  if (!result.ok) return sendPasteFailure(req, res, result);
  res.json(result);
});

// Read a task's agent conversation as normalized entries — the data behind the mobile
// "阅读 / Reading" view. Incremental: pass the previous ?since byte cursor + ?source id
// to get only what's new; a changed source (e.g. /clear started a fresh Claude session)
// makes the client reload from the top. Read-only + best-effort: a task with no
// transcript yet returns an empty stream. Remote transcripts require a future
// node-local read verb and never fall back to controller-side filesystem access.
app.get("/api/tasks/:id/transcript", async (req, res) => {
  const lang = langFromReq(req);
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: tr(lang, "notFound") });
  const since = Math.max(0, parseInt(String(req.query.since ?? "0"), 10) || 0);
  const source = req.query.source ? String(req.query.source) : null;
  try {
    res.json(await readTranscript(localRunner, task, since, source));
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// archive: end the tmux session but KEEP the worktree (moves task to archived tab)
app.post("/api/tasks/:id/archive", async (req, res) => {
  const lang = langFromReq(req);
  const task = getTask.get(req.params.id) as Task | undefined;
  if (!task) return res.status(404).json({ error: tr(lang, "notFound") });
  try {
    await killSession(localRunner, task.session);
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
  const repo = getRepo.get(task.repo_id) as Repo | undefined;
  try {
    await killSession(localRunner, task.session);
    if (repo?.mirror_path) await removeWorktree(localRunner, repo.mirror_path, task.worktree_path, task.work_branch);
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
  if (!(await localRunner.exists(task.worktree_path).catch(() => false))) {
    return res.status(409).json({ error: tr(lang, "task.worktreeGone") });
  }
  try {
    const alreadyAlive = await hasSession(localRunner, task.session).catch(() => false);
    // resume on the SAME agent + model/backend the task was created with: claude
    // re-injects its provider env; codex re-runs `codex resume --last` with its
    // recorded model. providerEnv is empty for a codex task (provider_id is NULL).
    const provider = task.provider_id ? (getProvider.get(task.provider_id) as Provider | undefined) : undefined;
    if (!alreadyAlive) await startSession(localRunner, task.session, task.worktree_path, null, {
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
  if (!getTask.get(req.params.id)) return res.status(404).json({ error: tr(lang, "notFound") });
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
  if (!task) return res.status(404).json({ error: tr(langFromReq(req), "notFound") });
  if (task.worktree_path && (await localRunner.exists(task.worktree_path).catch(() => false))) {
    return res.status(409).json({ error: tr(langFromReq(req), "task.worktreeExists") });
  }
  db.prepare("DELETE FROM tasks WHERE id=?").run(req.params.id);
  removeTaskManifest(DATA_DIR, Number(req.params.id));
  res.json({ ok: true });
});

// ---------- fleet (cross-node task view) ----------
// Fetch one node's OWN task list live: `ssh <node> <wrapper> list --json`. A
// wall-clock timeout bounds a half-dead node so it degrades to "unreachable"
// (aggregateNodes catches the throw) instead of stalling the whole fleet view.
async function nodeListFetch(t: FleetTarget): Promise<string> {
  const out = await runNodeCommand(t, ["list", "--json"], { timeoutMs: 8000 });
  if (!out.ok) throw new Error(out.stderr || "node list failed");
  return out.stdout;
}

// One read-only code-inspection endpoint for both contexts used by the UI:
// owner-local repo/tasks are inspected here; node-owned fleet items relay the
// same typed request to `tdsp inspect-code` on that owner. The browser never
// supplies mirror/worktree paths.
app.post("/api/code/inspect", async (req, res) => {
  const lang = langFromReq(req);
  const request = req.body as CodeInspectRequest & { node_id?: number };
  if (!isCodeInspectRequest(request)) {
    return res.status(400).json({ code: "invalidRequest", error: "Invalid code inspection request" });
  }
  if (request.node_id != null && (!Number.isInteger(request.node_id) || request.node_id <= 0)) {
    return res.status(400).json({ code: "invalidRequest", error: "Invalid code inspection node" });
  }
  res.setHeader("cache-control", "no-store");

  if (request.node_id != null) {
    const host = getHost.get(request.node_id) as Host | undefined;
    if (!host || host.kind === "local") return res.status(404).json({ error: tr(lang, "notFound") });
    if (!host.tdsp_bin) return res.status(409).json({ code: "nodeUpdateRequired", error: tr(lang, "host.nodeUpdateRequired") });
    if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
    const nodeRequest = { ...request } as any;
    delete nodeRequest.node_id;
    const out = await runNodeCommand(host, ["inspect-code", b64Json(nodeRequest)]);
    const result = parseNodeJson(out.stdout);
    if (!result) {
      if (isUnknownTdspCommand(`${out.stderr}\n${out.stdout}`, "inspect-code")) {
        return res.status(409).json({ code: "nodeUpdateRequired", error: tr(lang, "host.nodeUpdateRequired") });
      }
      return res.status(502).json({ error: `node code inspection failed: ${(out.stderr || "no result").slice(0, 300)}` });
    }
    if (result.ok) return res.json(result);
    return res.status(codeErrorStatus(String(result.error || "inspectFailed")))
      .json({ code: result.error, error: result.message || result.error });
  }

  let result;
  if (request.scope === "repo") {
    const repo = getRepo.get(request.id) as Repo | undefined;
    if (!repo) return res.status(404).json({ error: tr(lang, "notFound") });
    result = await codeResult(() => inspectRepoCode(localRunner, repo, request));
  } else {
    const task = getTask.get(request.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: tr(lang, "notFound") });
    result = await codeResult(() => inspectTaskCode(localRunner, task, request));
  }
  if (result.ok) return res.json(result);
  return res.status(codeErrorStatus(result.error)).json({ code: result.error, error: result.message });
});

// One glass: every node's tasks read from its OWN truth. The local node comes
// from this controller's DB; each bootstrapped remote is fetched live and merged
// (offline → unreachable, older schema → version, no wrapper yet → notBootstrapped).
// Honest per-node status, never a silent drop.
app.get("/api/fleet", async (_req, res) => {
  const hosts = db.prepare("SELECT * FROM hosts ORDER BY (kind='local') DESC, id DESC").all() as Host[];
  const [aggregated, localPayload] = await Promise.all([
    aggregateNodes(fleetTargets(hosts), nodeListFetch),
    taskListPayload(db, async (tasks) => new Map(await Promise.all(tasks.map(async (task) => [
      task.id,
      {
        alive: task.status !== "cleaned" && await hasSession(localRunner, task.session).catch(() => false),
        hasWorktree: !!task.worktree_path && await localRunner.exists(task.worktree_path).catch(() => false),
        waiting: task.status !== "cleaned" && !!task.worktree_path
          && await localRunner.exists(path.join(task.worktree_path, ".claude/waiting")).catch(() => false),
      },
    ] as const)))),
  ]);
  const byId = new Map(aggregated.map((a) => [a.node.id, a]));
  const nodes = hosts.map((h) => {
    const base = { node: { id: h.id, name: h.name }, kind: h.kind };
    if (h.kind === "local") return { ...base, ok: true, ...localPayload };
    const agg = byId.get(h.id);
    if (agg) {
      const capabilities = agg.capabilities ?? [];
      return {
        ...base,
        ok: agg.ok,
        reason: agg.reason,
        schema_version: agg.schema_version,
        capabilities,
        needsUpdate: agg.ok && !capabilities.includes(NODE_CONTROL_CAPABILITY),
        tasks: agg.tasks ?? [],
        repos: agg.repos ?? [],
      };
    }
    return { ...base, ok: false, reason: "notBootstrapped" as const };
  });
  res.json({ schema_version: 1, nodes });
});

function b64Json(body: unknown) {
  return Buffer.from(JSON.stringify(body ?? {})).toString("base64");
}

function remoteHost(req: Request, res: Response): Host | undefined {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.hostId) as Host | undefined;
  if (!host || host.kind === "local") {
    res.status(404).json({ error: tr(lang, "notFound") });
    return undefined;
  }
  if (!host.tdsp_bin) {
    res.status(409).json({ code: "switchyardRequired", error: "Switchyard is not installed on this node" });
    return undefined;
  }
  if (offline(host)) {
    res.status(409).json({ error: tr(lang, "host.offline") });
    return undefined;
  }
  return host;
}

async function runNodeJson(host: Host, args: string[], input?: Buffer) {
  const out = await runNodeCommand(host, args, { input });
  return { out, result: parseNodeJson(out.stdout) };
}

function sendMissingNodeCommand(req: Request, res: Response, command: string, out: { stdout: string; stderr: string }) {
  if (isUnknownTdspCommand(`${out.stderr}\n${out.stdout}`, command)) {
    return res.status(409).json({ code: "nodeUpdateRequired", error: tr(langFromReq(req), "host.nodeUpdateRequired") });
  }
  return res.status(502).json({ error: `node ${command} failed: ${(out.stderr || "no result").slice(0, 300)}` });
}

// Repository CRUD is relayed as node-local commands. A never receives or uses
// the node's mirror path or token.
app.post("/api/nodes/:hostId/repos", async (req, res) => {
  const host = remoteHost(req, res);
  if (!host) return;
  const { out, result } = await runNodeJson(host, ["repo-create", b64Json(req.body ?? {})]);
  if (!result) return sendMissingNodeCommand(req, res, "repo-create", out);
  if (!result.ok) return sendRepoFailure(req, res, result);
  res.json(result);
});

app.post("/api/nodes/:hostId/repos/:repoId/fetch", async (req, res) => {
  const host = remoteHost(req, res);
  if (!host) return;
  const { out, result } = await runNodeJson(host, ["repo-fetch", String(req.params.repoId)]);
  if (!result) return sendMissingNodeCommand(req, res, "repo-fetch", out);
  if (!result.ok) return sendRepoFailure(req, res, result);
  res.json({ ok: true });
});

app.get("/api/nodes/:hostId/repos/:repoId/branches", async (req, res) => {
  const host = remoteHost(req, res);
  if (!host) return;
  const { out, result } = await runNodeJson(host, ["repo-branches", String(req.params.repoId)]);
  if (!result) return sendMissingNodeCommand(req, res, "repo-branches", out);
  if (!result.ok) return sendRepoFailure(req, res, result);
  res.json(result.branches ?? []);
});

app.delete("/api/nodes/:hostId/repos/:repoId", async (req, res) => {
  const host = remoteHost(req, res);
  if (!host) return;
  const args = ["repo-delete", String(req.params.repoId)];
  if (req.query.force === "1" || req.query.force === "true") args.push("--force");
  const { out, result } = await runNodeJson(host, args);
  if (!result) return sendMissingNodeCommand(req, res, "repo-delete", out);
  if (!result.ok) return sendRepoFailure(req, res, result);
  res.json({ ok: true });
});

// Dispatch refers only to a repo id owned by B; B resolves its own mirror and
// performs every worktree/session/database mutation locally.
app.post("/api/nodes/:hostId/tasks", async (req, res) => {
  const lang = langFromReq(req);
  const host = remoteHost(req, res);
  if (!host) return;
  const { repo_id, base, title, prompt, agent, provider_id } = req.body ?? {};
  if (!Number.isInteger(Number(repo_id)) || !base || !title) return res.status(400).json({ error: tr(lang, "task.fieldsRequired") });
  const agentKind = asAgentKind(agent);
  const spec = {
    repo_id: Number(repo_id),
    base,
    title,
    prompt: prompt || null,
    skills: Array.isArray(req.body?.skills) ? req.body.skills.map(String) : [],
    agent: agentKind,
    model: req.body?.model ?? req.body?.agent_model ?? null,
    provider_id: agentKind === "claude" && provider_id ? Number(provider_id) : null,
  };
  const { out, result } = await runNodeJson(host, ["create", b64Json(spec)]);
  if (!result) return sendMissingNodeCommand(req, res, "create", out);
  if (result.ok) return res.json({ id: result.id, session: result.session, work_branch: result.workBranch, node: host.id });
  if (result.error === "skillsMissing") return res.status(400).json({ error: tr(lang, "skill.missing", { keys: (result.missing || []).join(", ") }) });
  if (result.error === "repoNotFound") return res.status(404).json({ error: tr(lang, "repo.notFound") });
  if (result.error === "repoNotReady") return res.status(409).json({ error: tr(lang, "repo.status", { status: result.message || "unknown" }) });
  return res.status(500).json({ error: result.message || result.error });
});

app.post("/api/nodes/:hostId/tasks/local", async (req, res) => {
  const lang = langFromReq(req);
  const host = remoteHost(req, res);
  if (!host) return;
  const { out, result } = await runNodeJson(host, [
    "create-local", "--cwd", String(req.body?.cwd ?? ""), "--title", String(req.body?.title ?? ""),
  ]);
  if (!result) return sendMissingNodeCommand(req, res, "create-local", out);
  if (result.ok) return res.json({ id: result.id, session: result.session, node: host.id });
  if (result.error === "cwdMissing") return res.status(400).json({ error: tr(lang, "task.cwdMissing", { cwd: String(req.body?.cwd ?? "") }) });
  return res.status(500).json({ error: result.message || result.error });
});

// Raw bytes travel over SSH stdin; B resolves the task, writes the file, updates
// git excludes and pastes the reference into its own tmux session.
app.post("/api/nodes/:hostId/tasks/:taskId/paste-image", express.raw({ type: "image/*", limit: "25mb" }), async (req, res) => {
  const host = remoteHost(req, res);
  if (!host) return;
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId)) return res.status(400).json({ error: "invalid task id" });
  const { out, result } = await runNodeJson(
    host,
    ["paste-image", String(taskId), String(req.headers["content-type"] || "")],
    req.body as Buffer,
  );
  if (!result) return sendMissingNodeCommand(req, res, "paste-image", out);
  if (!result.ok) return sendPasteFailure(req, res, result);
  res.json(result);
});

// Provider catalog on a remote node. The controller only relays these calls; the
// provider rows and tokens live in the same DB as the tasks that will use them.
app.get("/api/nodes/:hostId/providers", async (req, res) => {
  const host = remoteHost(req, res);
  if (!host) return;
  const { result } = await runNodeJson(host, ["providers-list"]);
  if (!result || !result.ok) return res.status(502).json({ error: result?.error || "node providers failed" });
  // Older nodes returned full provider rows. Re-project on A as a second guard
  // so credentials and endpoint coordinates never reach A's browser.
  res.json(providerSummaries(result.providers));
});

app.post("/api/nodes/:hostId/providers/test", async (req, res) => {
  const host = remoteHost(req, res);
  if (!host) return;
  const { result } = await runNodeJson(host, ["providers-test", b64Json(req.body ?? {})]);
  if (result?.ok) return res.json({ ok: true });
  res.status(400).json({ error: result?.error || "node provider test failed" });
});

app.post("/api/nodes/:hostId/providers", async (req, res) => {
  const host = remoteHost(req, res);
  if (!host) return;
  const { result } = await runNodeJson(host, ["providers-create", b64Json(req.body ?? {})]);
  if (result?.ok) return res.json({ id: result.id });
  res.status(400).json({ error: result?.error || "node provider save failed" });
});

app.delete("/api/nodes/:hostId/providers/:id", async (req, res) => {
  const host = remoteHost(req, res);
  if (!host) return;
  const { result } = await runNodeJson(host, ["providers-delete", String(req.params.id)]);
  if (result?.ok) return res.json({ ok: true });
  res.status(400).json({ error: result?.error || "node provider delete failed" });
});

app.get("/api/nodes/:hostId/skills", async (req, res) => {
  const host = remoteHost(req, res);
  if (!host) return;
  const { out, result } = await runNodeJson(host, ["skills-list"]);
  if (!result) return sendMissingNodeCommand(req, res, "skills-list", out);
  if (!result.ok) return res.status(502).json({ error: result.error || "node skills failed" });
  res.json(result.skills ?? []);
});

app.get("/api/nodes/:hostId/plugins/available", async (req, res) => {
  const host = remoteHost(req, res);
  if (!host) return;
  const { out, result } = await runNodeJson(host, ["plugins-list"]);
  if (!result) return sendMissingNodeCommand(req, res, "plugins-list", out);
  if (!result.ok) return res.status(502).json({ error: result.error || "node plugins failed" });
  res.json(result.plugins ?? []);
});

app.post("/api/nodes/:hostId/plugins/install", async (req, res) => {
  const host = remoteHost(req, res);
  if (!host) return;
  const { out, result } = await runNodeJson(host, ["plugins-install", b64Json(req.body ?? {})]);
  if (!result) return sendMissingNodeCommand(req, res, "plugins-install", out);
  if (!result.ok) return res.status(500).json({ error: result.error || "node plugin install failed" });
  res.json({ ok: true });
});

// Relay a lifecycle verb to the node that owns the task. The controller never
// mutates fleet task rows itself: the node owns their DB, sessions, worktrees,
// provider configuration and manifests.
async function relayNodeTaskAction(req: Request, res: Response, verb: "stop" | "resume" | "cleanup" | "delete-task") {
  const lang = langFromReq(req);
  const host = remoteHost(req, res);
  if (!host) return;
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId)) return res.status(400).json({ error: "invalid task id" });
  const out = await runNodeCommand(host, [verb, String(taskId)]);
  const result = parseNodeJson(out.stdout);
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
    listOwnedTasks(db).filter((task) => task.status !== "cleaned")
      .map((r) => r.session)
  );
  res.json(names.map((name) => ({ name, orphan: !known.has(name) })));
});

app.post("/api/sessions/:name/kill", async (req, res) => {
  const lang = langFromReq(req);
  const name = req.params.name;
  if (!SESSION_RE.test(name)) return res.status(400).json({ error: tr(lang, "session.invalid") });
  const task = listOwnedTasks(db).find((candidate) => candidate.session === name);
  // An orphan (no owner-local task row) may be a live session from another
  // Switchyard instance sharing this machine's tmux server. Refuse to kill it
  // unless explicitly forced.
  if (!task && req.body?.force !== true) {
    return res.status(409).json({ error: tr(lang, "session.orphanRefused", { name }) });
  }
  const removeWt = req.body?.removeWorktree !== false; // default: also delete worktree
  await killSession(localRunner, name);

  let removedWorktree = false;
  if (task) {
    if (removeWt) {
      const repo = getRepo.get(task.repo_id) as Repo | undefined;
      if (repo?.mirror_path) await removeWorktree(localRunner, repo.mirror_path, task.worktree_path, task.work_branch);
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

// ---------- hosts (registered node transports) ----------
app.get("/api/hosts", (_req, res) => {
  // Local machine first. Filesystem/bootstrap coordinates stay server-side;
  // the browser only needs identity, transport label and liveness.
  const hosts = db.prepare("SELECT * FROM hosts ORDER BY (kind='local') DESC, id DESC").all() as Host[];
  res.json(hosts.map(publicHost));
});

app.post("/api/hosts", async (req, res) => {
  const { name, target, kind } = req.body ?? {};
  if (!name || !target) return res.status(400).json({ error: "name and target required" });
  const k = kind === "mosh" ? "mosh" : "ssh";
  const cleanTarget = String(target).trim();
  const profile = typeof req.body?.profile === "string" ? req.body.profile.trim() : "";
  let tdspBin: string | null = null;

  // Advanced/canary path: the operator already installed an isolated profile on
  // B. Verify that exact node API before recording B, so A can never silently
  // fall back to B's canonical tdsp or controller-owned state.
  if (profile) {
    if (!validProfileName(profile)) {
      return res.status(400).json({ error: "profile must be 1-32 lowercase letters, numbers, or hyphens" });
    }
    try {
      const runner = new RemoteRunner(cleanTarget);
      const home = (await runner.exec("sh", ["-c", 'printf %s "$HOME"'])).trim();
      if (!home.startsWith("/")) throw new Error("remote home is unavailable");
      tdspBin = path.posix.join(home, ".task-dispatcher", "profiles", profile, "bin", "tdsp");
      const check = await runNodeCommand(
        { kind: k, target: cleanTarget, tdsp_bin: tdspBin },
        ["list", "--json"],
        { timeoutMs: 30_000 },
      );
      const payload = parseNodeJson(check.stdout);
      if (!check.ok || typeof payload?.schema_version !== "number") {
        return res.status(409).json({
          code: "profileUnavailable",
          error: `Switchyard profile "${profile}" is not ready on the target; run tdsp install --profile ${profile} there first`,
        });
      }
    } catch {
      return res.status(409).json({
        code: "profileUnavailable",
        error: `could not reach Switchyard profile "${profile}" on the target`,
      });
    }
  }

  const info = db.prepare("INSERT INTO hosts (name, target, kind, tdsp_bin, connection_source) VALUES (?,?,?,?, 'manual')")
    .run(String(name).trim(), cleanTarget, k, tdspBin);
  const id = Number(info.lastInsertRowid);
  probeHost(getHost.get(id) as Host); // probe right away so it goes online fast (fire-and-forget)
  res.json({ id, profile: profile || null, ready: !!tdspBin });
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

  const runner = transportRunnerFor(host);
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
    res.json({ ok: true, strategy: result.strategy, nodeVersion: result.nodeVersion, cloned: result.cloned });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Self-update is another node-local verb: A requests it, B updates its own install.
app.post("/api/hosts/:id/update", async (req, res) => {
  const lang = langFromReq(req);
  const host = getHost.get(req.params.id) as Host | undefined;
  if (!host || host.kind === "local") return res.status(404).json({ error: tr(lang, "notFound") });
  if (!host.tdsp_bin) return res.status(409).json({ code: "switchyardRequired", error: "Switchyard is not installed on this node" });
  if (offline(host)) return res.status(409).json({ error: tr(lang, "host.offline") });
  const out = await runNodeCommand(host, ["update", "--json"], { timeoutMs: 10 * 60 * 1000 });
  const result = parseNodeJson(out.stdout);
  if (!result) return sendMissingNodeCommand(req, res, "update", out);
  if (!result.ok) return res.status(500).json({ error: result.error || "update failed" });
  res.json({ ok: true, head: result.head, log: result.head || "updated" });
});

app.delete("/api/hosts/:id", (req, res) => {
  const host = getHost.get(req.params.id) as Host | undefined;
  if (host?.kind === "local") return res.status(409).json({ error: "cannot delete the local machine" });
  if (host?.managed_ssh === 1 && host.node_id) {
    try { removeSwitchyardKey(host.node_id); } catch {}
  }
  db.prepare("DELETE FROM hosts WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- providers (alternate model backends for claude) ----------
app.get("/api/providers", (_req, res) => {
  res.json(providersForList(db));
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
  clearProviderFromOwnedTasks(db, req.params.id);
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
