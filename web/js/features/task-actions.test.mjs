import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../css/app.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const tasks = readFileSync(new URL("./tasks.js", import.meta.url), "utf8");
const hosts = readFileSync(new URL("./hosts.js", import.meta.url), "utf8");
const terminal = readFileSync(new URL("./terminal.js", import.meta.url), "utf8");

test("task code action lives at the right edge of the tmux bar, not on cards", () => {
  const bar = html.match(/<div class="termbar">([\s\S]*?)<\/div>\s*<!-- mobile-only/)?.[1] || "";
  assert.match(bar, /id="term-code"/);
  assert.ok(bar.indexOf('id="term-code"') > bar.indexOf('id="term-claude"'));
  assert.doesNotMatch(tasks, /class="card-code"/);
  assert.doesNotMatch(hosts, /class="card-code"/);
  assert.match(terminal, /applyCodeTarget\(p\.codeTarget\)/);
  assert.match(terminal, /openCodeView\(target\.id, target\.nodeId\)/);
});

test("stop action keeps a restrained dark-red border", () => {
  assert.match(css, /\.card-x\.stop\s*\{[^}]*border-color:\s*color-mix\(in srgb, var\(--red\) 28%, var\(--border\)\);/s);
});
