// Runtime repository references: the terminal-bar action and its small modal.
// The browser sends only task/repo ids, branch and alias. The owning node decides
// where to materialize the task-local snapshot. The live agent is never touched.
import { $, api } from "../core/dom.js";
import { toast } from "../core/feedback.js";
import { state } from "../core/state.js";

const MAX_REFERENCES = 8;
let target = null; // { id, nodeId, repoId, title, agent, references[] }
let branchRequest = null;
let branchesLoading = false;
let submitting = false;
let submissionStartedAt = 0;
let submissionTimer = null;
let dismissedWhileSubmitting = false;
let refreshLocal = async () => {};
let refreshFleet = async () => {};

function agentName(agent) {
  return agent === "codex" ? "Codex" : agent === "kimi" ? "Kimi Code" : "Claude Code";
}

function nodeRepos() {
  return target?.nodeId == null
    ? state.repos
    : (state.fleet[target.nodeId]?.repos || []);
}

function catalog() {
  return nodeRepos().filter((repo) =>
    Number(repo.id) !== Number(target?.repoId) && (!repo.status || repo.status === "ready"),
  );
}

function aliasSlug(value, repoId) {
  const slug = String(value || "").toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 32);
  return slug || `repo-${repoId}`;
}

function uniqueAlias(value, repoId) {
  const seed = aliasSlug(value, repoId);
  const used = new Set((target?.references || []).map((reference) => aliasSlug(reference.alias, reference.repo_id)));
  if (!used.has(seed)) return seed;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = seed.slice(0, 32 - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
  return `${seed.slice(0, 28)}-ref`;
}

function selectedRepo() {
  const id = Number($("rr-repo").value);
  return catalog().find((repo) => Number(repo.id) === id) || null;
}

function setStatus(message = "", error = false) {
  const el = $("rr-status");
  el.textContent = message;
  el.classList.toggle("error", !!error);
}

function renderSubmittingStatus() {
  if (!submitting) return;
  const seconds = Math.max(0, Math.floor((Date.now() - submissionStartedAt) / 1000));
  setStatus(I18N.t(seconds ? "runtimeRef.addingElapsed" : "runtimeRef.adding", { seconds }));
}

function renderCurrentReferences() {
  const references = Array.isArray(target?.references) ? target.references.filter(Boolean) : [];
  const section = $("rr-current");
  section.hidden = references.length === 0;
  $("rr-current-count").textContent = `${references.length}/${MAX_REFERENCES}`;
  const repos = nodeRepos();
  const rows = references.map((reference) => {
    const row = document.createElement("div");
    row.className = "runtime-ref-current-row";
    const copy = document.createElement("div");
    copy.className = "runtime-ref-current-copy";
    const alias = document.createElement("code");
    alias.className = "runtime-ref-current-alias";
    alias.textContent = `ref:${reference.alias}`;
    const repo = repos.find((candidate) => Number(candidate.id) === Number(reference.repo_id));
    const source = document.createElement("span");
    source.className = "runtime-ref-current-source";
    source.textContent = `${reference.repo_name || repo?.name || `#${reference.repo_id}`}/${reference.requested_ref || "?"}`;
    const commit = document.createElement("code");
    commit.className = "runtime-ref-current-commit";
    commit.textContent = String(reference.resolved_commit || "").slice(0, 8) || "—";
    commit.title = reference.resolved_commit || "";
    copy.append(alias, source);
    row.append(copy, commit);
    return row;
  });
  $("rr-current-list").replaceChildren(...rows);
}

function setSubmitting(on) {
  submitting = on;
  if (submissionTimer) clearInterval(submissionTimer);
  submissionTimer = null;
  $("rr-repo").disabled = on;
  $("rr-branch").disabled = on || branchesLoading;
  $("rr-alias").disabled = on;
  // Closing only dismisses the modal; the owner node safely finishes its
  // atomic snapshot in the background and the eventual result still toasts.
  $("rr-cancel").disabled = false;
  $("rr-cancel").textContent = I18N.t(on ? "dialog.close" : "dialog.cancel");
  $("rr-submit").disabled = on || branchesLoading;
  $("rr-submit").classList.toggle("loading", on);
  $("rr-submit").textContent = I18N.t(on ? "runtimeRef.submitting" : "runtimeRef.submit");
  if (on) {
    submissionStartedAt = Date.now();
    dismissedWhileSubmitting = false;
    renderSubmittingStatus();
    submissionTimer = setInterval(renderSubmittingStatus, 1000);
  }
}

function renderDynamicCopy() {
  if (!target) return;
  const agent = agentName(target.agent);
  $("rr-task").textContent = I18N.t("runtimeRef.taskMeta", {
    id: target.id,
    title: target.title || "",
    agent,
    count: (target.references || []).length,
  });
  $("rr-agent-hint").textContent = I18N.t("runtimeRef.manifestHint");
  $("rr-alias").placeholder = I18N.t("runtimeRef.aliasPh");
  $("rr-submit").textContent = I18N.t(submitting ? "runtimeRef.submitting" : "runtimeRef.submit");
  $("rr-cancel").textContent = I18N.t(submitting ? "dialog.close" : "dialog.cancel");
  renderCurrentReferences();
  renderSubmittingStatus();
}

async function loadBranches(repo, preferred = null) {
  branchRequest?.abort();
  const controller = branchRequest = new AbortController();
  branchesLoading = true;
  $("rr-branch").replaceChildren(new Option(I18N.t("runtimeRef.loadingBranches"), ""));
  $("rr-branch").disabled = true;
  $("rr-submit").disabled = true;
  try {
    const url = target.nodeId == null
      ? `/api/repos/${repo.id}/branches`
      : `/api/nodes/${target.nodeId}/repos/${repo.id}/branches`;
    const result = await api(url, { signal: controller.signal });
    const branches = Array.isArray(result) && result.length ? result : [repo.default_branch || "main"];
    const selected = branches.includes(preferred)
      ? preferred
      : branches.includes(repo.default_branch) ? repo.default_branch : branches[0];
    $("rr-branch").replaceChildren(...branches.map((branch) => new Option(branch, branch, false, branch === selected)));
  } catch (error) {
    if (error.name === "AbortError") return;
    const fallback = repo.default_branch || preferred || "main";
    $("rr-branch").replaceChildren(new Option(fallback, fallback, true, true));
  } finally {
    if (branchRequest === controller) {
      branchesLoading = false;
      $("rr-branch").disabled = submitting;
      $("rr-submit").disabled = submitting;
    }
  }
}

function chooseRepo(repo) {
  if (!repo) return;
  $("rr-alias").value = uniqueAlias(repo.name, repo.id);
  setStatus();
  void loadBranches(repo);
}

export function openRuntimeReference(nextTarget) {
  if (!nextTarget) return;
  if (submitting) {
    renderDynamicCopy();
    $("runtime-ref-modal").style.display = "flex";
    return;
  }
  target = {
    ...nextTarget,
    agent: nextTarget.agent === "codex" || nextTarget.agent === "kimi" ? nextTarget.agent : "claude",
    references: Array.isArray(nextTarget.references) ? nextTarget.references : [],
  };
  const repos = catalog();
  const canAdd = target.references.length < MAX_REFERENCES && repos.length > 0;
  $("rr-add-form").hidden = !canAdd;
  $("rr-submit").hidden = !canAdd;
  setSubmitting(false);
  renderDynamicCopy();
  $("runtime-ref-modal").style.display = "flex";
  if (!canAdd) {
    setStatus(I18N.t(target.references.length >= MAX_REFERENCES ? "runtimeRef.limit" : "runtimeRef.noRepos"));
    setTimeout(() => $("rr-cancel").focus(), 30);
    return;
  }

  const usedRepos = new Set(target.references.map((reference) => Number(reference.repo_id)));
  const first = repos.find((repo) => !usedRepos.has(Number(repo.id))) || repos[0];
  $("rr-repo").replaceChildren(...repos.map((repo) => new Option(repo.name, String(repo.id), false, Number(repo.id) === Number(first.id))));
  $("rr-alias").value = uniqueAlias(first.name, first.id);
  setStatus();
  void loadBranches(first);
  setTimeout(() => $("rr-repo").focus(), 30);
}

export function closeRuntimeReference() {
  if (submitting) {
    $("runtime-ref-modal").style.display = "none";
    if (!dismissedWhileSubmitting) toast(I18N.t("runtimeRef.background"), "success", 4000);
    dismissedWhileSubmitting = true;
    return;
  }
  branchRequest?.abort();
  branchRequest = null;
  target = null;
  $("runtime-ref-modal").style.display = "none";
}

export function runtimeReferenceIsOpen() {
  return $("runtime-ref-modal").style.display === "flex";
}

export function repaintRuntimeReference() {
  renderDynamicCopy();
  if (branchesLoading) {
    const option = $("rr-branch").options[0];
    if (option) option.textContent = I18N.t("runtimeRef.loadingBranches");
  }
}

export async function submitRuntimeReference() {
  if (!target || submitting || branchesLoading) return;
  const repo = selectedRepo();
  const branch = $("rr-branch").value;
  const alias = uniqueAlias($("rr-alias").value, repo?.id);
  $("rr-alias").value = alias;
  if (!repo || !branch || !alias) return;

  const activeTarget = target;
  setSubmitting(true);
  try {
    const url = activeTarget.nodeId == null
      ? `/api/tasks/${activeTarget.id}/references`
      : `/api/nodes/${activeTarget.nodeId}/tasks/${activeTarget.id}/references`;
    const result = await api(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_id: Number(repo.id), ref: branch, alias }),
    });
    if (result.reference && !activeTarget.references.some((reference) => reference.alias === result.reference.alias)) {
      activeTarget.references.push(result.reference);
    }
    const key = result.existing ? "runtimeRef.already" : "runtimeRef.attached";
    toast(I18N.t(key, { alias: result.reference?.alias || alias, agent: agentName(activeTarget.agent) }), "success", 5500);
    submitting = false;
    closeRuntimeReference();
    if (activeTarget.nodeId == null) await refreshLocal();
    else await refreshFleet();
  } catch (error) {
    const message = error?.body?.code === "nodeUpdateRequired"
      ? I18N.t("runtimeRef.nodeUpdate")
      : String(error?.message || error);
    setStatus(message, true);
    toast(message, "error", 6000);
    setSubmitting(false);
  }
}

export function initRuntimeReferences(options = {}) {
  refreshLocal = options.refreshLocal || refreshLocal;
  refreshFleet = options.refreshFleet || refreshFleet;
  $("rr-repo").addEventListener("change", () => chooseRepo(selectedRepo()));
  $("rr-alias").addEventListener("blur", () => {
    const repo = selectedRepo();
    if (repo) $("rr-alias").value = uniqueAlias($("rr-alias").value, repo.id);
  });
  $("rr-cancel").addEventListener("click", closeRuntimeReference);
  $("rr-submit").addEventListener("click", submitRuntimeReference);
  $("runtime-ref-modal").addEventListener("click", (event) => {
    if (event.target.id === "runtime-ref-modal") closeRuntimeReference();
  });
}
