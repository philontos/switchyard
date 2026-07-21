// Read-only repository/task code explorer. The server owns all Git/path safety;
// this module renders returned text with textContent only and never touches PTYs.
import { $, api } from "../core/dom.js";
import { toast } from "../core/feedback.js";
import { state } from "../core/state.js";
import { buildFileTree, sortedTreeChildren, diffLineKind } from "../core/codeview.js";
import { taskById } from "./tasks.js";

const CAPABILITY = "code-view-v1";
const MAX_DIFF_LINES = 10000;
const MAX_LINE_NUMBERS = 50000;
let context = null;                 // { scope, id, nodeId, name }
let tab = "files";
let tree = null, treeMeta = null, changes = null;
let selectedFile = null, selectedChange = null, currentPayload = null;
let openDirs = new Set();
let requestSerial = 0;
let activeRequest = null;

function mobile() { return matchMedia("(max-width: 760px)").matches; }

function repoFor(id, nodeId) {
  return nodeId != null
    ? state.fleet[nodeId]?.repos?.find((r) => Number(r.id) === Number(id))
    : state.repos.find((r) => Number(r.id) === Number(id));
}

function taskFor(id, nodeId) {
  return nodeId != null
    ? state.fleet[nodeId]?.tasks?.find((x) => Number(x.id) === Number(id))
    : taskById(id);
}

function nodeSupportsCode(nodeId) {
  return nodeId == null || !!state.fleet[nodeId]?.capabilities?.includes(CAPABILITY);
}

function setBusy(on) {
  const btn = $("cv-refresh");
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle("updating", on);
}

function resetState() {
  tree = treeMeta = changes = currentPayload = null;
  selectedFile = selectedChange = null;
  openDirs = new Set();
  $("code-modal").classList.remove("detail");
  $("cv-banner").className = "cv-banner";
  $("cv-banner").textContent = "";
  $("cv-path").textContent = "";
  $("cv-content").replaceChildren();
}

function updateChrome() {
  if (!context) return;
  $("cv-title").textContent = t(context.scope === "repo" ? "code.repoTitle" : "code.taskTitle", {
    name: context.name,
  });
  $("cv-tab-files").textContent = t("code.files");
  $("cv-tab-changes").textContent = changes
    ? t("code.changesCount", { count: changes.files.length })
    : t("code.changes");
  $("cv-tab-changes").style.display = context.scope === "task" ? "" : "none";
  $("cv-refresh").setAttribute("aria-label", t("code.refresh"));
  $("cv-close").setAttribute("aria-label", t("code.close"));
  for (const name of ["files", "changes"]) {
    const button = $(`cv-tab-${name}`);
    const on = tab === name;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", String(on));
  }
}

function setRevision(payload) {
  const rev = payload?.revision;
  if (!rev) { $("cv-revision").textContent = ""; return; }
  const short = String(rev.commit || "").slice(0, 9);
  const when = payload.generatedAt ? new Date(payload.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  $("cv-revision").textContent = `${rev.label} @ ${short}${rev.approximate ? ` · ${t("code.approximate")}` : ""}${when ? ` · ${when}` : ""}`;
}

function banner(message = "", kind = "") {
  const el = $("cv-banner");
  el.textContent = message;
  el.className = `cv-banner${message ? " on" : ""}${kind ? ` ${kind}` : ""}`;
}

function stateBox(target, message, loading = false) {
  const box = document.createElement("div");
  box.className = "cv-state";
  if (loading) {
    const spin = document.createElement("span");
    spin.className = "pg-spin";
    box.append(spin);
  }
  const text = document.createElement("span");
  text.textContent = message;
  box.append(text);
  target.replaceChildren(box);
}

async function inspect(operation, path, refresh = false) {
  if (!context) throw new Error("No code context");
  activeRequest?.abort();
  const controller = activeRequest = new AbortController();
  const serial = ++requestSerial;
  const body = {
    scope: context.scope, id: context.id, operation,
    ...(path != null ? { path } : {}),
    ...(refresh ? { refresh: true } : {}),
    ...(context.nodeId != null ? { node_id: context.nodeId } : {}),
  };
  const result = await api("/api/code/inspect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: controller.signal,
  });
  if (serial !== requestSerial || !context) throw new DOMException("Superseded", "AbortError");
  return result;
}

function fail(error, target = $("cv-content")) {
  if (error?.name === "AbortError") return;
  const message = error?.body?.code === "nodeUpdateRequired" ? t("code.nodeUpdate") : String(error?.message || error);
  stateBox(target, message);
  banner(message, "error");
}

function showSelectFile() {
  $("cv-path").textContent = "";
  stateBox($("cv-content"), t(tab === "files" ? "code.selectFile" : "code.selectChange"));
}

function renderTreeNode(node, parent, depth) {
  const { dirs, files } = sortedTreeChildren(node);
  for (const dir of dirs) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cv-item cv-dir";
    row.style.setProperty("--depth", depth);
    const isOpen = openDirs.has(dir.path);
    const caret = document.createElement("span");
    caret.className = "cv-caret";
    caret.textContent = isOpen ? "▾" : "▸";
    const label = document.createElement("span");
    label.className = "cv-item-label";
    label.textContent = dir.name;
    row.append(caret, label);
    row.onclick = () => {
      isOpen ? openDirs.delete(dir.path) : openDirs.add(dir.path);
      renderTree();
    };
    parent.append(row);
    if (isOpen) renderTreeNode(dir, parent, depth + 1);
  }
  for (const file of files) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cv-item cv-file";
    row.classList.toggle("selected", selectedFile === file.path);
    row.style.setProperty("--depth", depth);
    row.title = file.path;
    const mark = document.createElement("span");
    mark.className = "cv-file-mark";
    mark.textContent = "·";
    const label = document.createElement("span");
    label.className = "cv-item-label";
    label.textContent = file.name;
    row.append(mark, label);
    row.onclick = () => selectFile(file.path);
    parent.append(row);
  }
}

function renderTree() {
  const nav = $("cv-nav");
  nav.replaceChildren();
  if (!tree) return stateBox(nav, t("code.loading"), true);
  if (!treeMeta?.files?.length) return stateBox(nav, t("code.emptyRepo"));
  const list = document.createElement("div");
  list.className = "cv-list";
  renderTreeNode(tree, list, 0);
  nav.append(list);
}

function renderChanges() {
  const nav = $("cv-nav");
  nav.replaceChildren();
  if (!changes) return stateBox(nav, t("code.loading"), true);
  if (!changes.files.length) return stateBox(nav, t("code.noChanges"));
  const list = document.createElement("div");
  list.className = "cv-list cv-change-list";
  for (const file of changes.files) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cv-item cv-change";
    row.classList.toggle("selected", selectedChange === file.path);
    row.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
    const status = document.createElement("span");
    status.className = `cv-status s-${file.status === "?" ? "new" : file.status.toLowerCase()}`;
    status.textContent = file.status === "?" ? "A" : file.status;
    const label = document.createElement("span");
    label.className = "cv-item-label";
    label.textContent = file.path;
    row.append(status, label);
    row.onclick = () => selectChange(file.path);
    list.append(row);
  }
  nav.append(list);
}

async function loadTree(refresh = false) {
  tree = treeMeta = null;
  renderTree();
  showSelectFile();
  banner();
  try {
    const data = await inspect("tree", null, refresh && context.scope === "repo");
    treeMeta = data;
    tree = buildFileTree(data.files);
    setRevision(data);
    if (data.truncated) banner(t("code.treeTruncated"), "warn");
    renderTree();
  } catch (error) { fail(error, $("cv-nav")); }
}

async function loadChanges() {
  changes = null;
  renderChanges();
  showSelectFile();
  banner();
  try {
    changes = await inspect("changes");
    setRevision(changes);
    updateChrome();
    renderChanges();
    if (!changes.files.length) showSelectFile();
  } catch (error) { fail(error, $("cv-nav")); }
}

function formatBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function unavailableMessage(payload) {
  const key = {
    binary: "code.binary", tooLarge: "code.tooLarge", symlink: "code.symlink", submodule: "code.submodule",
  }[payload.unavailable] || "code.unavailable";
  return t(key, { size: formatBytes(payload.size) });
}

function renderFile(payload) {
  currentPayload = payload;
  setRevision(payload);
  $("cv-path").textContent = `${payload.path} · ${formatBytes(payload.size)}`;
  const content = $("cv-content");
  content.replaceChildren();
  if (payload.content == null) return stateBox(content, unavailableMessage(payload));

  const scroll = document.createElement("div");
  scroll.className = "cv-code-scroll";
  const source = document.createElement("pre");
  source.className = "cv-source";
  source.textContent = payload.content;
  const lines = document.createElement("pre");
  lines.className = "cv-lines";
  const count = Math.max(1, payload.content.split("\n").length - (payload.content.endsWith("\n") ? 1 : 0));
  // A pathological one-megabyte file can contain nearly one million blank
  // lines. Source still renders safely; omit the decorative gutter before it
  // becomes the expensive part of the preview.
  if (count <= MAX_LINE_NUMBERS) {
    lines.textContent = Array.from({ length: count }, (_, i) => String(i + 1)).join("\n");
    scroll.append(lines);
  }
  scroll.append(source);
  content.append(scroll);
}

function renderDiff(payload) {
  currentPayload = payload;
  setRevision(payload);
  $("cv-path").textContent = payload.path;
  const content = $("cv-content");
  content.replaceChildren();
  if (payload.binary) return stateBox(content, t("code.binaryDiff"));
  if (payload.content == null) return stateBox(content, t("code.diffTooLarge"));
  const allLines = payload.content.split("\n");
  const renderLines = allLines.slice(0, MAX_DIFF_LINES);
  if (payload.truncated || renderLines.length < allLines.length) banner(t("code.diffTruncated"), "warn"); else banner();

  const pre = document.createElement("div");
  pre.className = "cv-diff";
  const fragment = document.createDocumentFragment();
  for (const line of renderLines) {
    const row = document.createElement("div");
    row.className = `cv-diff-line ${diffLineKind(line)}`;
    row.textContent = line || " ";
    fragment.append(row);
  }
  pre.append(fragment);
  content.append(pre);
}

async function selectFile(path) {
  selectedFile = path;
  currentPayload = null;
  renderTree();
  $("code-modal").classList.add("detail");
  $("cv-path").textContent = path;
  stateBox($("cv-content"), t("code.loading"), true);
  banner(treeMeta?.truncated ? t("code.treeTruncated") : "", treeMeta?.truncated ? "warn" : "");
  try { renderFile(await inspect("file", path)); }
  catch (error) { fail(error); }
}

async function selectChange(path) {
  selectedChange = path;
  currentPayload = null;
  renderChanges();
  $("code-modal").classList.add("detail");
  $("cv-path").textContent = path;
  stateBox($("cv-content"), t("code.loading"), true);
  banner();
  try { renderDiff(await inspect("diff", path)); }
  catch (error) { fail(error); }
}

export function setCodeTab(next) {
  if (!context || (next !== "files" && next !== "changes") || (next === "changes" && context.scope !== "task")) return;
  activeRequest?.abort();
  activeRequest = null;
  requestSerial++;
  tab = next;
  currentPayload = null;
  $("code-modal").classList.remove("detail");
  updateChrome();
  if (tab === "files") {
    if (tree) { renderTree(); showSelectFile(); }
    else loadTree();
  } else if (changes) {
    renderChanges(); showSelectFile();
  } else loadChanges();
}

async function openCode(nextContext) {
  if (nextContext.nodeId != null && !nodeSupportsCode(nextContext.nodeId)) {
    toast(t("code.nodeUpdate"), "error", 6000);
    return;
  }
  context = nextContext;
  tab = "files";
  resetState();
  updateChrome();
  $("code-modal").style.display = "flex";
  $("cv-close").focus();
  await loadTree();
}

export function openRepoCode(id, nodeId = null) {
  const repo = repoFor(id, nodeId);
  return openCode({ scope: "repo", id: Number(id), nodeId: nodeId == null ? null : Number(nodeId), name: repo?.name || `#${id}` });
}

export function openTaskCode(id, nodeId = null) {
  const task = taskFor(id, nodeId);
  return openCode({ scope: "task", id: Number(id), nodeId: nodeId == null ? null : Number(nodeId), name: task ? `#${id} ${task.title}` : `#${id}` });
}

export function closeCodeView() {
  activeRequest?.abort();
  activeRequest = null;
  requestSerial++;
  context = null;
  $("code-modal").style.display = "none";
  resetState();
  setBusy(false);
}

export function codeBack() {
  if (!mobile() || !$("code-modal").classList.contains("detail")) return;
  $("code-modal").classList.remove("detail");
}

export async function refreshCodeView() {
  if (!context) return;
  setBusy(true);
  activeRequest?.abort();
  tree = treeMeta = changes = currentPayload = null;
  selectedFile = selectedChange = null;
  openDirs = new Set();
  $("code-modal").classList.remove("detail");
  updateChrome();
  try {
    if (tab === "changes") await loadChanges();
    else await loadTree(true);
  } finally { setBusy(false); }
}

export function repaintCodeView() {
  if (!context) return;
  updateChrome();
  if (tab === "files") renderTree(); else renderChanges();
  if (currentPayload?.kind === "file") renderFile(currentPayload);
  else if (currentPayload?.kind === "diff") renderDiff(currentPayload);
  else showSelectFile();
}

export function isCodeViewOpen() {
  return $("code-modal")?.style.display === "flex";
}

export function initCodeView() {
  $("cv-close").addEventListener("click", closeCodeView);
  $("cv-refresh").addEventListener("click", refreshCodeView);
  $("cv-tab-files").addEventListener("click", () => setCodeTab("files"));
  $("cv-tab-changes").addEventListener("click", () => setCodeTab("changes"));
  $("cv-back").addEventListener("click", codeBack);
  $("code-modal").addEventListener("click", (event) => { if (event.target.id === "code-modal") closeCodeView(); });
}
