// Tasks: the dispatch-task modal, the live/archived card lists, task lifecycle
// (archive / remove-worktree / delete), and connect() which attaches the dock
// to a task's tmux session. paintSelection() reflects the currently-open card
// and is shared with hosts.js (a remote shell clears the task selection).
import { $, api } from "./dom.js";
import { toast, showLoading, hideLoading } from "./feedback.js";
import { confirmDialog } from "./dialog.js";
import { Selects } from "./select.js";
import { state } from "./state.js";
import { openPty, disposePty, prunePanes, setClaudeSession,
         openPending, failPending, closePending, pendingIsActive } from "./terminal.js";
import { rerender } from "./hosts.js";

let taskRepoId = null, branchReq = null, tasksById = {}, taskOrder = [];
// id of the task whose title is being edited inline. While set, renderList()
// (the single place that rebuilds #m-list) bails, so NONE of the re-render paths
// — loadTasks (4s), loadHosts (5s), loadRepos, a language switch — can blow the
// open input away mid-edit. finish() re-renders once, on commit/cancel.
let editingTaskId = null;
export function isEditingTask() { return editingTaskId != null; }

// reflect the current selection onto the cards already in the DOM (no refetch)
export function paintSelection() {
  document.querySelectorAll("#m-list .task").forEach(el => {
    el.classList.toggle("selected", Number(el.dataset.id) === state.selectedTaskId);
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
  openPty(`session=${encodeURIComponent(t.session)}`,
    `#${t.id} ${t.title}`, t.prompt ? `· ${t.prompt}` : "", "tmux attach -t " + t.session, t.id, t.claude_session || "");
}

export function openTaskModal(repoId) {
  const repo = state.repos.find(r => r.id === repoId && r.status === "ready");
  if (!repo) return toast(t("toast.repoNotReady"), "error");
  taskRepoId = repoId;
  $("tm-repo").textContent = repo.name;
  $("t-title").value = ""; $("t-prompt").value = "";   // fresh form each open
  $("task-modal").style.display = "flex";
  loadBranches();
  loadDispatchOptions();
  setTimeout(() => $("t-title").focus(), 30);
}
export function closeTaskModal() { $("task-modal").style.display = "none"; }

// Shell: one click, zero form. Opens a bare tmux shell in the machine's home —
// the server auto-names it and defaults the cwd to home; the user then cd's and
// runs claude (or anything) themselves. hostId picks the machine (omit → local).
// Deliberately bare-bones for a fast start; repo/branch/worktree/prompt
// all live in the richer repo dispatch flow instead.
export async function addLocalTask(hostId) {
  const tmpId = nextTmpId();
  openPending(tmpId, t("term.creating"), "", t("local.starting"));
  try {
    const body = hostId != null ? JSON.stringify({ host_id: hostId }) : "{}";
    const r = await api("/api/tasks/local", { method: "POST", headers: { "content-type": "application/json" }, body });
    await loadTasks();
    settlePending(tmpId, r.id);
    toast(t("toast.taskDispatched", { session: r.session }), "success");
  } catch (e) {
    await loadTasks();
    rejectPending(tmpId, e.message);
  }
}

// extra-skill checkboxes for the dispatch modal; reset each open. Dispatch works
// fine even if this fails to load (just no skills offered).
async function loadDispatchOptions() {
  $("t-skills").innerHTML = "";
  try {
    const skills = await api("/api/skills");
    $("t-skills").innerHTML = skills.length
      ? skills.map(s => `<label class="skopt"><input type="checkbox" value="${s.key}"> ${s.name} <span class="sksrc">${s.source}</span></label>`).join("")
      : `<div class="muted">${t("skill.none")}</div>`;
  } catch (e) { /* leave empty — a task can still be dispatched without skills */ }
}
function selectedExtraSkills() {
  return [...document.querySelectorAll("#t-skills input:checked")].map(i => i.value);
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

export async function addTask() {
  const body = {
    repo_id: Number(taskRepoId), base_branch: Selects["t-base"].value,
    title: $("t-title").value.trim(), prompt: $("t-prompt").value,
    extra_skills: selectedExtraSkills(),
  };
  if (!body.repo_id || !body.base_branch || !body.title) return toast(t("toast.taskFieldsRequired"), "error");
  // Open the dock placeholder BEFORE clearing the form so its title can label it,
  // then close the modal immediately — no global overlay, the loading lives in the
  // window. The POST runs in the background and resolves into the same window.
  const tmpId = nextTmpId();
  openPending(tmpId, body.title, body.prompt ? `· ${body.prompt}` : "", t("loading.creatingWorktree"));
  $("t-title").value = ""; $("t-prompt").value = "";
  closeTaskModal();
  try {
    const r = await api("/api/tasks", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
    await loadTasks();
    settlePending(tmpId, r.id);
    toast(t("toast.taskDispatched", { session: r.session }), "success");
  } catch (e) {
    await loadTasks();
    rejectPending(tmpId, e.message);
  }
}

// client-side temp ids for in-flight creation placeholders (no real task id yet)
let tmpSeq = 0;
function nextTmpId() { return "tmp" + (++tmpSeq); }

// Creation succeeded: if its placeholder is still the visible dock view, swap to
// the live terminal; otherwise just drop the (backgrounded) placeholder — the task
// is now a normal card the user can click.
function settlePending(tmpId, taskId) {
  if (pendingIsActive(tmpId)) connect(taskId);   // showPane() clears the placeholder
  closePending(tmpId);
}

// Creation failed: show the error in its window if still visible, else fall back to
// a toast (the failed task also surfaces as an error card via loadTasks()).
function rejectPending(tmpId, message) {
  if (pendingIsActive(tmpId)) { failPending(tmpId, message); return; }
  closePending(tmpId);
  toast(t("toast.dispatchFailed", { error: message }), "error", 6000);
}

export function taskCard(t, online) {
  const active = t.status !== "cleaned";
  // one corner action per state — stop (active) / cleanup (cleaned)
  // NOTE: the param is `t` (the task), so it shadows the global t() — use I18N.t here.
  // `needsHost` actions run a command ON the machine, so they're disabled while
  // the machine is offline; "delete record" is pure DB and stays available.
  let icon, note = "";
  if (active) {
    icon = { glyph: "⏹", title: I18N.t("task.stopTitle"), fn: `archive(${t.id})`, needsHost: true };
  } else if (t.hasWorktree) {
    icon = { glyph: "🗑", title: I18N.t("task.removeWorktree"), fn: `removeWt(${t.id})`, needsHost: true };
    note = `<div class="muted">${I18N.t("task.worktreeKept")}</div>`;
  } else {
    icon = { glyph: "🗑", title: I18N.t("task.deleteRecord"), fn: `deleteTask(${t.id})`, needsHost: false };
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
  // the title is its own click zone: single clicks don't bubble to the card (so
  // they never connect()), double-click renames it in place.
  const head = `<div class="t">${dot}#${t.id} <span class="tname" title="${I18N.t("task.renameHint")}" onclick="event.stopPropagation()" ondblclick="renameTask(event,${t.id})">${t.title}</span></div>
    ${meta}`;
  // only attach-on-click when there's a live session to attach to; a resumable
  // (dead-session) card routes through its Resume button instead.
  const open = (active && t.alive) ? ` clickable" onclick="connect(${t.id})` : "";
  const sel = t.id === state.selectedTaskId ? " selected" : "";
  // data-repo marks a card as drag-reorderable (reorder.js) — only active repo
  // tasks: shells have no repo group, archived/cleaned ones aren't reorderable.
  const drag = active && t.kind !== "local" ? ` data-repo="${t.repo_id}"` : "";
  return `<div class="card task${sel}${open}" data-id="${t.id}"${drag}>
    <button class="card-x" title="${icon.title}" ${disabled ? "disabled" : ""} onclick="event.stopPropagation();${icon.fn}">${icon.glyph}</button>
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
export async function archive(id){
  if(!await confirmDialog(t("task.killConfirm"),{title:t("task.killTitle"),okText:t("dialog.ok"),danger:true}))return;
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
