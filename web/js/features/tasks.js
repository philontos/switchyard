// Tasks: the dispatch-task modal, the live/archived card lists, task lifecycle
// (archive / remove-worktree / delete), and connect() which attaches the dock
// to a task's tmux session. paintSelection() reflects the currently-open card
// and is shared with hosts.js (a remote shell clears the task selection).
import { $, api } from "../core/dom.js";
import { toast, showLoading, hideLoading } from "../core/feedback.js";
import { confirmDialog } from "../core/dialog.js";
import { Selects } from "../core/select.js";
import { state } from "../core/state.js";
import { openPty, disposePty, prunePanes, setClaudeSession,
         openPending, failPending, closePending, pendingIsActive, showPending } from "./terminal.js";
import { rerender, expandRepo, loadFleet, connectNode } from "./hosts.js";
import { refreshProviders, selectedProviderId, setProviderTarget } from "./providers.js";
// One-way: mobile.js never imports tasks.js (its sheet-close callback is injected by
// main.js), so this edge is acyclic. sheetOpened/sheetCancelled give the dispatch
// sheet its own mobile history entry — see the navEntry block in mobile.js for why.
import { sheetOpened, sheetCancelled } from "./mobile.js";

let taskRepoId = null, branchReq = null, tasksById = {}, taskOrder = [];
// the dispatch modal's agent pick (Claude Code | Codex | Kimi Code), remembered across opens.
const LS_AGENT = "tdsp.agent";
let selectedAgent = "claude";
function normalizeAgent(kind) {
  return kind === "codex" || kind === "kimi" ? kind : "claude";
}
// whether the modal's current target node has a provider catalog reachable from
// this UI. Providers belong to the node that will run the task: local catalog for
// local tasks, remote catalog through tdsp for bootstrapped remote nodes.
let modalProviderAvailable = true;
// when set, the dispatch modal is in "node mode": dispatch to a remote node's OWN
// repo (surfaced via the fleet) instead of a controller-registered repo.
let nodeTask = null;   // { hostId, repo } or null
// id of the task whose title is being edited inline. While set, renderList()
// (the single place that rebuilds #m-list) bails, so NONE of the re-render paths
// — loadTasks (4s), loadHosts (5s), loadRepos, a language switch — can blow the
// open input away mid-edit. finish() re-renders once, on commit/cancel.
let editingTaskId = null;
export function isEditingTask() { return editingTaskId != null; }

// reflect the current selection onto the cards already in the DOM (no refetch).
// Three kinds of card, matched by which key they carry:
//   data-pending → a placeholder, lit while its loading window is the active dock
//   data-pane    → a remote node's task, keyed by its string pane id ("n<host>:<id>")
//   data-id      → a local task, keyed by its numeric id
// The data-pane branch is what stops this poll-driven repaint from stripping a
// selected remote card (its pane id never matched the numeric data-id test, so it
// used to flip back off every refresh — the flicker the remote view showed).
export function paintSelection() {
  // Mobile: no visual selected-state at all. Master-detail means you're either ON
  // the list or INSIDE a task — a highlighted card is stale information by the time
  // you can see it, and its late repaint used to read as a jumping/double border on
  // the way back. selectedTaskId itself stays tracked (the dock re-attach and
  // lastTaskByHost logic need it); only the paint is suppressed.
  const mob = document.body.classList.contains("mobile");
  document.querySelectorAll("#m-list .task").forEach(el => {
    const on = !mob && (el.dataset.pending != null
      ? pendingIsActive(el.dataset.pending)
      : el.dataset.pane != null
        ? el.dataset.pane === state.selectedTaskId
        : Number(el.dataset.id) === state.selectedTaskId);
    el.classList.toggle("selected", on);
  });
}

// The machine a task lives on: shells carry host_id directly; repo tasks inherit
// it from their repo. Returns null if it can't be resolved (e.g. repo not loaded).
export function hostOfTask(t) {
  if (t.host_id != null) return Number(t.host_id);
  const repo = state.repos.find(r => r.id === t.repo_id);
  return repo ? Number(repo.host_id) : null;
}

export function connect(id) {
  const t = tasksById[id];
  if (!t) return;
  state.selectedTaskId = id;
  // remember this as the machine's "current" task so a later switch back to it
  // re-attaches the dock here instead of stranding it on another machine's session
  const hid = hostOfTask(t);
  if (hid != null) state.lastTaskByHost[hid] = id;
  paintSelection();
  const codeTarget = t.kind !== "local" && t.hasWorktree ? { id: t.id, nodeId: null } : null;
  openPty(`session=${encodeURIComponent(t.session)}`,
    `#${t.id} ${t.title}`, "tmux attach -t " + t.session, t.id, t.claude_session || "", t.agent, codeTarget);
}

// The agent picker (Claude Code | Codex | Kimi Code). Persists the last pick so the next
// dispatch defaults to it, repaints the segmented control, and reflects the
// choice onto the modal's panels via applyAgentUI.
export function selectAgent(kind) {
  selectedAgent = normalizeAgent(kind);
  try { localStorage.setItem(LS_AGENT, selectedAgent); } catch (_) {}
  document.querySelectorAll("#t-agent-seg .agent-opt").forEach(b =>
    b.classList.toggle("selected", b.dataset.agent === selectedAgent));
  applyAgentUI();
}

// Reflect the selected agent onto the modal: codex/kimi use a model field;
// Claude uses the target node's provider catalog when it is reachable.
function applyAgentUI() {
  const external = selectedAgent !== "claude";
  $("t-codex-sec").style.display = external ? "" : "none";
  const model = $("t-codex-model");
  model.placeholder = t(selectedAgent === "kimi" ? "agent.kimiModelPh" : "agent.codexModelPh");
  const note = $("t-agent-auto-note");
  note.textContent = t(selectedAgent === "kimi" ? "agent.kimiAutoNote" : "agent.codexAutoNote");
  if (external) {
    $("t-provider-sec").style.display = "none";
    $("prov-panel").style.display = "none";
  } else if (modalProviderAvailable) {
    $("t-provider-sec").style.display = "";
  }
}

export function openTaskModal(repoId) {
  const repo = state.repos.find(r => r.id === repoId && r.status === "ready");
  if (!repo) return toast(t("toast.repoNotReady"), "error");
  nodeTask = null;
  taskRepoId = repoId;
  $("tm-repo").textContent = repo.name;
  $("t-title").value = ""; $("t-prompt").value = "";   // fresh form each open
  $("prov-panel").style.display = "none";              // collapse the manage panel
  modalProviderAvailable = true;
  setProviderTarget(null);
  $("t-provider-sec").style.display = "";
  // the agent picker shows for local AND remote repos — agent is a task property
  // that travels to whichever node runs it.
  // selectAgent() runs applyAgentUI, so it must come AFTER the provider-sec base
  // visibility. The last-picked agent is restored either way.
  $("t-agent-sec").style.display = "";
  $("t-codex-model").value = "";
  selectAgent(normalizeAgent(localStorage.getItem(LS_AGENT)));
  sheetOpened();   // claim the mobile history entry BEFORE the sheet paints (list still on the glass)
  $("task-modal").style.display = "flex";
  loadBranches();
  if (modalProviderAvailable) refreshProviders();      // fill the target node's backend picker
  setTimeout(() => $("t-title").focus(), 30);
}
// Pure DOM close, shared by every path. Dispatch calls THIS (the sheet's history
// entry is then morphed into the terminal entry by enterTerminal — never popped).
export function closeTaskModal() {
  const modal = $("task-modal");
  if (modal.contains(document.activeElement)) document.activeElement.blur();
  modal.style.display = "none";
  branchReq?.abort();
  nodeTask = null;
}
// Cancel paths (取消 button / backdrop / Esc) additionally consume the sheet's
// mobile history entry; the platform back gesture takes the popstate route instead
// (mobile.js closes the sheet via its injected hook).
export function cancelTaskModal() { closeTaskModal(); sheetCancelled(); }

// Open the dispatch modal for a remote node's OWN repo (from the fleet). The task
// is created ON the node, using the node's existing mirror — no re-registration
// here. Branches are listed live by the node itself (its mirror is over there);
// title and prompt behave exactly like a local dispatch.
export function openNodeTaskModal(hostId, repoId) {
  const repo = state.fleet[hostId]?.repos?.find(r => r.id === repoId && (!r.status || r.status === "ready"));
  if (!repo) return toast(t("toast.repoNotReady"), "error");
  nodeTask = { hostId, repo };
  taskRepoId = null;
  const hostName = state.hostsById[hostId]?.name || hostId;
  $("tm-repo").textContent = `${repo.name} @ ${hostName}`;
  $("t-title").value = ""; $("t-prompt").value = "";
  $("prov-panel").style.display = "none";
  modalProviderAvailable = true;
  setProviderTarget(hostId);
  $("t-provider-sec").style.display = "";
  // agent still travels to the node, so each supported CLI is choosable here too.
  $("t-agent-sec").style.display = "";
  $("t-codex-model").value = "";
  selectAgent(normalizeAgent(localStorage.getItem(LS_AGENT)));
  sheetOpened();   // claim the mobile history entry BEFORE the sheet paints (list still on the glass)
  $("task-modal").style.display = "flex";
  loadNodeBranches(hostId, repo);
  refreshProviders();
  setTimeout(() => $("t-title").focus(), 30);
}

// Ask the node to list its mirror's branches (git ls-remote runs over there). On
// failure, fall back to the repo's default branch so dispatch still works.
async function loadNodeBranches(hostId, repo) {
  branchReq?.abort();
  const ctl = branchReq = new AbortController();
  Selects["t-base"].setLoading(t("task.loadingBranches"));
  try {
    const branches = await api(`/api/nodes/${hostId}/repos/${repo.id}/branches`, { signal: ctl.signal });
    Selects["t-base"].setOptions(branches.map(b => ({ value: b, label: b })), repo.default_branch);
  } catch (e) {
    if (e.name === "AbortError") return;
    Selects["t-base"].setOptions([{ value: repo.default_branch, label: repo.default_branch }], repo.default_branch);
  }
}

// Shell: one click, zero form. Opens a bare tmux shell in the machine's home —
// the server auto-names it and defaults the cwd to home; the user then cd's and
// runs claude (or anything) themselves. hostId picks the machine (omit → local).
// Deliberately bare-bones for a fast start; repo/branch/worktree/prompt
// all live in the richer repo dispatch flow instead.
export async function addLocalTask() {
  const tmpId = nextTmpId();
  const hid = localHostId();
  openPending(tmpId, t("term.creating"), "", t("local.starting"));
  addPendingCard(tmpId, { kind: "local", repoId: null, hostId: hid, title: t("term.creating"), agent: "claude" });
  try {
    const r = await api("/api/tasks/local", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    dropPendingCard(tmpId);          // the real card replaces the placeholder
    await loadTasks();
    settlePending(tmpId, r.id);
    toast(t("toast.taskDispatched", { session: r.session }), "success");
  } catch (e) {
    dropPendingCard(tmpId);
    await loadTasks();
    rejectPending(tmpId, e.message);
  }
}

// Open a new bare shell ON a remote node (sinks via the node's own tdsp). The shell
// lives on the node, so it surfaces through the fleet. Mirrors addLocalTask's optimistic
// feel — a dock loading window + placeholder card up before the (ssh-slow) POST — then
// attaches to the node's live shell via the fleet path (loadFleet + connectNode).
export async function addNodeShell(hostId) {
  const tmpId = nextTmpId();
  openPending(tmpId, t("term.creating"), "", t("local.starting"));
  addPendingCard(tmpId, { kind: "local", repoId: null, hostId, title: t("term.creating"), agent: "claude" });
  try {
    const r = await api(`/api/nodes/${hostId}/tasks/local`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    dropPendingCard(tmpId);          // the real fleet card replaces the placeholder
    await loadFleet();
    settleNodePending(tmpId, hostId, r.id);
    nudgeFleet();
    toast(t("toast.taskDispatched", { session: r.session }), "success");
  } catch (e) {
    dropPendingCard(tmpId);
    await loadFleet();
    rejectPending(tmpId, e.message);
  }
}

async function loadBranches() {
  const id = taskRepoId;
  if (!id) { Selects["t-base"].setOptions([]); return; }
  branchReq?.abort();                         // drop any in-flight request from a previous switch
  const ctl = branchReq = new AbortController();
  Selects["t-base"].setLoading(t("task.loadingBranches"));
  try {
    const branches = await api(`/api/repos/${id}/branches`, { signal: ctl.signal });
    const repo = state.repos.find(r=>r.id==id);
    Selects["t-base"].setOptions(branches.map(b => ({ value: b, label: b })), repo?.default_branch);
  } catch(e){
    if (e.name === "AbortError") return;       // superseded by a newer switch — leave the latest in charge
    Selects["t-base"].setOptions([{ value: "", label: e.message }]);
  }
}

// Dispatch a repo task to a remote node's own repo. The node creates the worktree
// from its existing mirror + owns the task, so it surfaces via the fleet (not this
// controller's db). Optimistic like a local dispatch: a placeholder card + dock
// spinner cover the POST, which blocks while the node builds the worktree (git fetch
// over ssh can be slow), then settle into the node's live terminal.
async function addNodeTask() {
  const { hostId, repo } = nodeTask;
  const external = selectedAgent !== "claude";
  const providerShown = $("t-provider-sec").style.display !== "none";
  const body = {
    repo_id: repo.id,
    base: Selects["t-base"].value, title: $("t-title").value.trim(),
    prompt: $("t-prompt").value,
    provider_id: providerShown ? selectedProviderId() : null,
    agent: selectedAgent,
    model: external ? ($("t-codex-model").value.trim() || null) : null,
  };
  if (!body.base || !body.title) return toast(t("toast.taskFieldsRequired"), "error");
  // Same optimistic feedback as a local dispatch (addTask): a dock loading window +
  // a placeholder card in the node's repo group, both up BEFORE the POST — which is
  // ssh-slow (the node fetches the branch + builds the worktree over there), so a
  // click must never sit silent. The card carries hostId so it lands only in this
  // node's fleet group; on success it settles into the node's live terminal.
  const tmpId = nextTmpId();
  closeTaskModal();
  openPending(tmpId, body.title, body.prompt ? `· ${body.prompt}` : "", t("loading.creatingWorktree"));
  addPendingCard(tmpId, { kind: "repo", repoId: repo.id, hostId, title: body.title, agent: body.agent });
  try {
    const r = await api(`/api/nodes/${hostId}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    dropPendingCard(tmpId);          // the real fleet card replaces the placeholder
    await loadFleet();
    settleNodePending(tmpId, hostId, r.id);
    nudgeFleet();                    // catch the creating→running flip before the 15s poll
    toast(t("toast.taskDispatched", { session: r.session }), "success");
  } catch (e) {
    dropPendingCard(tmpId);
    await loadFleet();
    rejectPending(tmpId, e.message);
  }
}

export async function addTask() {
  if (nodeTask) return addNodeTask();
  // provider_id belongs to the target node's own provider catalog. A hidden picker
  // sends null, which means the target node's default Claude login.
  const providerShown = $("t-provider-sec").style.display !== "none";
  const external = selectedAgent !== "claude";
  const body = {
    repo_id: Number(taskRepoId), base_branch: Selects["t-base"].value,
    title: $("t-title").value.trim(), prompt: $("t-prompt").value,
    provider_id: providerShown ? selectedProviderId() : null,   // null == default claude login
    agent: selectedAgent,
    agent_model: external ? ($("t-codex-model").value.trim() || null) : null,
  };
  if (!body.repo_id || !body.base_branch || !body.title) return toast(t("toast.taskFieldsRequired"), "error");
  // Spin up BOTH placeholders before clearing the form (so the title can label them):
  // a card in the left list (selected, replacing the old selection) and the dock
  // loading window. Expand the repo group so the new card is visible even if it was
  // collapsed. The POST runs in the background and resolves into the same window —
  // success → live terminal, failure → inline error — with no global overlay.
  const tmpId = nextTmpId();
  closeTaskModal();
  openPending(tmpId, body.title, body.prompt ? `· ${body.prompt}` : "", t("loading.creatingWorktree"));
  expandRepo(body.repo_id);
  addPendingCard(tmpId, { kind: "repo", repoId: body.repo_id, hostId: null, title: body.title, agent: body.agent });
  $("t-title").value = ""; $("t-prompt").value = "";
  try {
    const r = await api("/api/tasks", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
    dropPendingCard(tmpId);          // the real card replaces the placeholder
    await loadTasks();
    settlePending(tmpId, r.id);
    toast(t("toast.taskDispatched", { session: r.session }), "success");
  } catch (e) {
    dropPendingCard(tmpId);
    await loadTasks();
    rejectPending(tmpId, e.message);
  }
}

// client-side temp ids for in-flight creation placeholders (no real task id yet)
let tmpSeq = 0;
function nextTmpId() { return "tmp" + (++tmpSeq); }

// ---- optimistic placeholder cards (left list) ----
// Mirror the dock loading window (terminal.js) with a card in the list, so creation
// gives instant feedback in BOTH places. Keyed by the same client temp id, dropped
// the moment the POST resolves; loadTasks() then renders the real card. repoId/hostId
// /kind place the card in the right group; title labels it.
let pendingCards = new Map();   // tmpId -> { tmpId, repoId, hostId, kind, title, agent }

// Register a placeholder and make it the selection (clearing whatever card was open —
// the new task takes over the dock), then re-render so it paints into the list.
function addPendingCard(tmpId, info) {
  pendingCards.set(tmpId, { tmpId, ...info });
  state.selectedTaskId = null;
  rerender();
}
function dropPendingCard(tmpId) { pendingCards.delete(tmpId); }

// the local machine's id, for shell placeholders dispatched without an explicit host
function localHostId() {
  const h = Object.values(state.hostsById).find(h => h.kind === "local");
  return h ? h.id : null;
}

// pending cards belonging to a repo group / a machine's Shells group (hosts.js renderList).
// Local controller repos carry hostId == null; a remote node's repo card carries the
// node's id and renders via pendingNodeRepoCards — the two never cross-render even if a
// controller repo id happens to equal a node's fleet repo id (separate DBs).
export function pendingRepoCards(repoId) {
  return [...pendingCards.values()].filter(p => p.kind === "repo" && p.hostId == null && p.repoId === repoId);
}
export function pendingNodeRepoCards(hostId, repoId) {
  return [...pendingCards.values()].filter(p => p.kind === "repo" && p.hostId === hostId && p.repoId === repoId);
}
export function pendingShellCards(hostId) {
  return [...pendingCards.values()].filter(p => p.kind === "local" && p.hostId === hostId);
}
// A real (server-polled) 'creating' task is hidden while its optimistic placeholder
// is still up, so the two never double-render in the gap before the POST resolves.
// Repo tasks match on repo + title; shells match on host (a shell has no real title
// until the server assigns one).
export function isShadowedByPending(tk) {
  if (tk.status !== "creating") return false;
  for (const p of pendingCards.values()) {
    if (p.kind === "local") { if (tk.kind === "local" && p.hostId === tk.host_id) return true; }
    else if (tk.repo_id === p.repoId && p.title === tk.title) return true;
  }
  return false;
}
// The fleet-view twin of isShadowedByPending: a remote node's freshly-polled
// 'creating' task is hidden while our optimistic placeholder for it is still up, so
// the fleet card and the placeholder never briefly double-render (the 15s fleet poll
// can fire mid-dispatch). Matched within one host: repo tasks by repo + title, shells
// by host (a shell has no stable title until the node names it).
export function isShadowedByNodePending(hostId, tk) {
  if (tk.status !== "creating") return false;
  for (const p of pendingCards.values()) {
    if (p.hostId !== hostId) continue;
    if (p.kind === "local") { if (tk.kind === "local") return true; }
    else if (tk.repo_id === p.repoId && p.title === tk.title) return true;
  }
  return false;
}
// One placeholder card: a pulsing "creating" dot + the title, selected while its
// loading window is the active dock view, clickable to re-focus that window. No
// data-id/data-repo — it isn't connectable or drag-reorderable until it's real.
// NOTE: no selection class in the markup — selection is painted AFTER render by
// paintSelection (all three card kinds). Baking it into the HTML made the list's
// byte-identical rebuild cache miss on every selection change, so switching tasks
// forced a full innerHTML rebuild (animation restarts = the visible flash, and a
// transient old/new double-selection during the swap).
export function pendingCard(p) {
  // agent picks the card's colour (task-claude / task-codex / task-kimi accent bar + tint).
  const agent = normalizeAgent(p.agent);
  return `<div class="card task pending-card task-${agent} clickable" data-pending="${p.tmpId}" onclick="focusPending('${p.tmpId}')">
    <div class="t"><span class="sdot cloning" title="${I18N.t("task.creating")}"></span>
      <span class="tname">${p.title}</span></div>
    <div class="muted">${I18N.t("task.creating")}</div>
  </div>`;
}
// Clicking a still-loading placeholder card brings its window back to the dock.
export function focusPending(tmpId) {
  if (!showPending(tmpId)) return;   // already resolved — nothing to focus
  state.selectedTaskId = null;
  paintSelection();
}

// Creation succeeded: if its placeholder is still the visible dock view, swap to
// the live terminal; otherwise just drop the (backgrounded) placeholder — the task
// is now a normal card the user can click.
function settlePending(tmpId, taskId) {
  if (pendingIsActive(tmpId)) connect(taskId);   // showPane() clears the placeholder
  closePending(tmpId);
}

// The remote twin of settlePending: a node task lives in the fleet, so it attaches
// over ssh via connectNode (not the local connect). Call it after loadFleet(), so the
// just-created task is in the snapshot connectNode reads. If the snapshot hasn't caught
// it yet, connectNode no-ops and the card simply appears on the next fleet poll.
function settleNodePending(tmpId, hostId, taskId) {
  if (pendingIsActive(tmpId) && taskId != null) connectNode(hostId, taskId);
  closePending(tmpId);
}

// After a remote dispatch, the 15s fleet poll lags the creating→running flip; nudge a
// couple of quick refreshes so the new card's status light catches up promptly.
function nudgeFleet() { setTimeout(loadFleet, 2000); setTimeout(loadFleet, 6000); }

// Creation failed: show the error in its window if still visible, else fall back to
// a toast (the failed task also surfaces as an error card via loadTasks()).
function rejectPending(tmpId, message) {
  if (pendingIsActive(tmpId)) { failPending(tmpId, message); return; }
  closePending(tmpId);
  toast(t("toast.dispatchFailed", { error: message }), "error", 6000);
}

export function taskCard(t, online) {
  const active = t.status !== "cleaned";
  // agent picks the card's colour (task-claude / task-codex / task-kimi accent bar + tint).
  const agent = normalizeAgent(t.agent);
  // one corner action per state — stop (active) / cleanup (cleaned)
  // NOTE: the param is `t` (the task), so it shadows the global t() — use I18N.t here.
  // `needsHost` actions run a command ON the machine, so they're disabled while
  // the machine is offline; "delete record" is pure DB and stays available.
  let icon, note = "";
  if (active) {
    icon = { glyph: `<span class="stop-ico" aria-hidden="true"></span>`, cls: " stop", title: I18N.t("task.stopTitle"), fn: `archive(${t.id})`, needsHost: true };
  } else if (t.hasWorktree) {
    icon = { glyph: "🗑", cls: "", title: I18N.t("task.removeWorktree"), fn: `removeWt(${t.id})`, needsHost: true };
    note = `<div class="muted">${I18N.t("task.worktreeKept")}</div>`;
  } else {
    icon = { glyph: "🗑", cls: "", title: I18N.t("task.deleteRecord"), fn: `deleteTask(${t.id})`, needsHost: false };
  }
  const disabled = icon.needsHost && !online;
  // resumable: the worktree is on disk but the tmux session is gone — whether the
  // task is still live (mis-kill / host reboot / claude crash) OR already archived
  // (cleaned, worktree kept). Offer a one-click relaunch (claude --continue) that
  // reattaches the prior conversation; resuming an archived task flips it back to
  // running (server side), so it rejoins the active list on the next poll.
  const resumable = (active || t.status === "cleaned") && !t.alive && t.hasWorktree;
  const resumeBtn = resumable
    ? `<button class="t-resume" title="${I18N.t("task.resumeTitle")}" ${disabled ? "disabled" : ""} onclick="event.stopPropagation();resume(${t.id})">⟳ ${I18N.t("task.resume")}</button>`
    : "";
  // local quick tasks have no branch/MR — show their working dir + a "local" tag
  const meta = t.kind === "local"
    ? `<div class="muted">📂 <code>${t.cwd || "~"}</code> <span class="tag-local">${I18N.t("local.tag")}</span></div>`
    : `<div class="muted">${t.base_branch} → <code>${t.work_branch}</code></div>`;
  // dot: alive+waiting (blocked on a permission prompt) → yellow; alive → green; else status
  const dot = t.alive
    ? (t.waiting
        ? `<span class="sdot waiting" title="${I18N.t("task.waiting")}"></span>`
        : `<span class="sdot live" title="live"></span>`)
    : `<span class="sdot ${t.status}" title="${t.status}"></span>`;
  // Single-clicking the title opens the card; double-clicking still renames it.
  const head = `<div class="t">${dot}#${t.id} <span class="tname" title="${I18N.t("task.renameHint")}" ondblclick="renameTask(event,${t.id})">${t.title}</span></div>
    ${meta}`;
  // only attach-on-click when there's a live session to attach to; a resumable
  // (dead-session) card routes through its Resume button instead.
  const open = (active && t.alive) ? ` clickable" onclick="connect(${t.id})` : "";
  // selection is painted post-render by paintSelection, NOT baked into the markup —
  // see pendingCard's note (keeps the list's rebuild cache selection-agnostic).
  // data-repo marks a card as drag-reorderable (reorder.js) — only active repo
  // tasks: shells have no repo group, archived/cleaned ones aren't reorderable.
  const drag = active && t.kind !== "local" ? ` data-repo="${t.repo_id}"` : "";
  return `<div class="card task task-${agent}${open}" data-id="${t.id}"${drag}>
    <button class="card-x${icon.cls}" title="${icon.title}" aria-label="${icon.title}" ${disabled ? "disabled" : ""} onclick="event.stopPropagation();${icon.fn}">${icon.glyph}</button>
    ${head}${note}${resumeBtn}
  </div>`;
}

// Fetch ALL tasks into the cache (tasksById keeps every task so connect() works
// for any session, even one whose card is filtered out of the current machine),
// then re-render. The 4s poller calls this; rerender() (hosts.js) builds col2.
export async function loadTasks() {
  const tasks = await api("/api/tasks").catch(() => null);
  if (!tasks) return;
  tasksById = Object.fromEntries(tasks.map(t => [t.id, t]));
  taskOrder = tasks.map(t => t.id);          // preserve the API's id-DESC order
  // push each task's latest Claude session id into its live pane so the term-bar
  // chip lights up as soon as claude writes its id — no reconnect needed.
  for (const t of tasks) setClaudeSession(t.id, t.claude_session || "");
  // drop kept-alive terminals whose task is gone or whose session was killed
  // (status 'cleaned' == not connectable, mirrors taskCard's `active`). If the
  // open card was one of them, clear the now-dangling selection.
  const keep = new Set(tasks.filter(t => t.status !== "cleaned").map(t => t.id));
  if (prunePanes(keep).includes(state.selectedTaskId)) state.selectedTaskId = null;
  if (editingTaskId != null) return;         // a rename input is open — refresh the cache but leave the DOM alone
  rerender();
}

// Inline rename: double-clicking a card's title swaps it for a text input.
// Enter or click-away commits (PATCH /api/tasks/:id, title only); Esc cancels.
// We only touch the display title — the tmux session & git branch are unchanged.
export function renameTask(event, id) {
  event.stopPropagation();                    // don't let the card's onclick connect()
  const span = event.currentTarget;
  if (!span || editingTaskId === id) return;   // already editing this one
  const current = tasksById[id]?.title ?? span.textContent;
  editingTaskId = id;

  const input = document.createElement("input");
  input.className = "tname-edit";
  input.value = current;
  input.size = 1;                             // tiny intrinsic width — let flex size it, never force a wrap
  input.onclick = e => e.stopPropagation();   // clicks inside the field aren't card clicks
  input.ondblclick = e => e.stopPropagation();

  let done = false;                           // guards Enter-then-blur double commit
  const finish = async commit => {
    if (done) return; done = true;
    editingTaskId = null;
    const next = input.value.trim();
    if (commit && next && next !== current) {
      try {
        const r = await api(`/api/tasks/${id}`, {
          method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: next }),
        });
        if (tasksById[id]) tasksById[id].title = r.title;
        // a double-click opens the task in the dock first — keep its header fresh
        if (state.selectedTaskId === id) $("term-title").textContent = `#${id} ${r.title}`;
      } catch (e) { toast(e.message, "error"); }
    }
    rerender();                               // rebuild the card from the (maybe) updated cache
  };

  input.onkeydown = e => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);          // click away saves

  // Insert the field as a sibling of the (hidden) title span — i.e. a DIRECT flex
  // child of `.t` — so its flex sizing actually applies and it edits in place,
  // instead of rendering at its intrinsic width and wrapping onto a second line.
  span.style.display = "none";
  span.after(input);
  input.focus();
  input.select();
}

// All cached tasks in API order (id-DESC). renderList (hosts.js) reads this to
// group tasks under their repo / machine.
export function allTasks() { return taskOrder.map(id => tasksById[id]).filter(Boolean); }
export function taskById(id) { return tasksById[id] || null; }
export async function archive(id){
  const task = tasksById[id];
  const taskLabel = task ? `#${task.id} ${task.title}` : `#${id}`;
  if(!await confirmDialog(t("task.stopConfirm",{task:taskLabel}),{title:t("task.stopTitle"),okText:t("common.stop"),danger:true}))return;
  await api(`/api/tasks/${id}/archive`,{method:"POST"});
  disposePty(id);                                    // session is killed → tear the pane down
  if (id === state.selectedTaskId) state.selectedTaskId = null;
  toast(t("toast.killed"),"success"); loadTasks();
}
export async function removeWt(id){
  if(!await confirmDialog(t("task.removeWtConfirm"),{title:t("task.removeWorktree"),okText:t("common.delete"),danger:true}))return;
  await api(`/api/tasks/${id}/cleanup`,{method:"POST"});
  disposePty(id);
  if (id === state.selectedTaskId) state.selectedTaskId = null;
  toast(t("toast.worktreeRemoved"),"success"); loadTasks();
}
// Resume: relaunch the dead tmux session (claude --continue, same worktree) so it
// reattaches the prior conversation. After it reloads, the card goes live again
// and a normal click connects.
export async function resume(id){
  showLoading(t("loading.default"));
  try {
    await api(`/api/tasks/${id}/resume`,{method:"POST"});
    toast(t("toast.resumed"),"success");
    await loadTasks();
    connect(id);
  } catch (e) {
    toast(t("toast.resumeFailed",{error:e.message}),"error",6000);
  } finally {
    hideLoading();
  }
}
export function deleteTask(id){
  disposePty(id);
  if (id === state.selectedTaskId) state.selectedTaskId = null;
  api(`/api/tasks/${id}`,{method:"DELETE"}).then(loadTasks).catch(e=>toast(e.message,"error"));
}
