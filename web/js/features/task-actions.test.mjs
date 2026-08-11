import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../css/app.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const tasks = readFileSync(new URL("./tasks.js", import.meta.url), "utf8");
const hosts = readFileSync(new URL("./hosts.js", import.meta.url), "utf8");
const terminal = readFileSync(new URL("./terminal.js", import.meta.url), "utf8");
const runtimeReferences = readFileSync(new URL("./runtime-references.js", import.meta.url), "utf8");
const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");

test("task code action lives at the right edge of the tmux bar, not on cards", () => {
  const bar = html.match(/<div class="termbar">([\s\S]*?)<\/div>\s*<!-- mobile-only/)?.[1] || "";
  assert.match(bar, /id="term-code"/);
  assert.ok(bar.indexOf('id="term-code"') > bar.indexOf('id="term-claude"'));
  assert.doesNotMatch(tasks, /class="card-code"/);
  assert.doesNotMatch(hosts, /class="card-code"/);
  assert.match(terminal, /applyCodeTarget\(p\.codeTarget\)/);
  assert.match(terminal, /openCodeView\(target\.id, target\.nodeId\)/);
});

test("stop glyph gets the dark-red outline without framing the whole button", () => {
  const buttonRule = css.match(/\.card-x\.stop\s*\{([^}]*)\}/)?.[1] || "";
  assert.doesNotMatch(buttonRule, /border(?:-color)?\s*:/);
  assert.match(css, /\.stop-ico\s*\{[^}]*border:\s*1\.25px solid color-mix\(in srgb, var\(--red\) 45%, var\(--border\)\);/s);
});

test("dispatch modal ignores backdrop clicks and keeps explicit cancellation", () => {
  assert.doesNotMatch(main, /\$\("task-modal"\)\.addEventListener\("click"/);
  assert.match(html, /data-i18n="dialog\.cancel"\s+onclick="cancelTaskModal\(\)"/);
});

test("local and remote stop actions confirm before calling their APIs", () => {
  const localStop = tasks.match(/export async function archive\(id\)\{([\s\S]*?)\n\}/)?.[1] || "";
  const remoteStop = hosts.match(/export async function stopNodeTask\(hostId, taskId\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(localStop, /confirmDialogWithCheckbox\(t\("task\.stopConfirm"/);
  assert.match(localStop, /checkbox:task\?\.hasWorktree \? \{label:t\("task\.stopRemoveWorktree"\),checked:true\}/);
  assert.match(localStop, /decision\.checked \? "cleanup" : "archive"/);
  assert.ok(localStop.indexOf("confirmDialogWithCheckbox") < localStop.indexOf("decision.checked"));
  assert.match(remoteStop, /confirmDialogWithCheckbox\(t\("task\.stopConfirm"/);
  assert.match(remoteStop, /checkbox: task\?\.hasWorktree \? \{ label: t\("task\.stopRemoveWorktree"\), checked: true \}/);
  assert.match(remoteStop, /decision\.checked \? "cleanup" : "stop"/);
  assert.ok(remoteStop.indexOf("confirmDialogWithCheckbox") < remoteStop.indexOf("decision.checked"));
  assert.match(html, /id="dlg-check-input" type="checkbox"/);
  assert.match(css, /\.dlg-check input\s*\{[^}]*accent-color:\s*var\(--red\)/s);
});

test("local and remote task titles share inline rename with a visible saving state", () => {
  assert.match(tasks, /ondblclick="renameTask\(event,\$\{t\.id\}\)"/);
  assert.match(hosts, /ondblclick="renameTask\(event,\$\{tk\.id\},\$\{hostId\}\)"/);
  assert.match(tasks, /\/api\/nodes\/\$\{hostId\}\/tasks\/\$\{id\}/);
  assert.match(tasks, /input\.classList\.add\("saving"\)/);
  assert.match(tasks, /className = "tname-save-state"/);
  assert.match(css, /\.tname-save-state \.sync-icon\s*\{[^}]*animation:\s*spin/s);
});

test("desktop dispatch branch picker uses a larger drawn chevron", () => {
  assert.match(css, /@media \(min-width: 761px\)\s*\{[\s\S]*?#task-modal #t-base \.cs-caret\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/);
  assert.match(css, /#task-modal #t-base \.cs-caret::before\s*\{[^}]*border-right:\s*2px solid currentColor;[^}]*border-bottom:\s*2px solid currentColor;/s);
});

test("dispatch supports task-scoped repository references on local and capable remote nodes", () => {
  assert.match(html, /id="t-ref-sec"[\s\S]*?id="t-ref-add"[\s\S]*?id="t-ref-list"/);
  assert.match(tasks, /const TASK_REFERENCES_CAPABILITY = "task-references-v1"/);
  assert.match(tasks, /state\.fleet\[nodeTask\.hostId\]\?\.capabilities/);
  assert.match(tasks, /\breferences,\s*\n/);
  assert.match(tasks, /\/api\/nodes\/\$\{nodeTask\.hostId\}\/repos\/\$\{reference\.repoId\}\/branches/);
  assert.match(css, /\.tm-ref-row\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.tm-ref-alias\s*\{[^}]*grid-column:\s*1 \/ 3;/s);
});

test("the terminal bar can attach a task-local repository Ref without mutating the agent session", () => {
  const bar = html.match(/<div class="termbar">([\s\S]*?)<\/div>\s*<!-- mobile-only/)?.[1] || "";
  assert.match(bar, /id="term-ref"/);
  assert.match(html, /id="runtime-ref-modal"[\s\S]*?id="rr-repo"[\s\S]*?id="rr-branch"[\s\S]*?id="rr-alias"/);
  assert.match(terminal, /applyReferenceTarget\(p\.referenceTarget\)/);
  assert.match(terminal, /openReference\(target\)/);
  assert.match(tasks, /references: t\.references \|\| \[\]/);
  assert.match(hosts, /task-runtime-reference-manifest-v1/);
  assert.match(hosts, /references: tk\.references \|\| \[\]/);
  assert.match(runtimeReferences, /\/api\/tasks\/\$\{activeTarget\.id\}\/references/);
  assert.match(runtimeReferences, /\/api\/nodes\/\$\{activeTarget\.nodeId\}\/tasks\/\$\{activeTarget\.id\}\/references/);
  assert.doesNotMatch(runtimeReferences, /attachedResumed|attachedInPlace|attachedDeferred/);
  assert.match(main, /setReferenceOpener\(openRuntimeReference\)/);
  assert.match(css, /\.term-code, \.term-ref\s*\{/);
});
