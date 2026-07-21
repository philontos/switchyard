import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../css/app.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const feature = readFileSync(new URL("./codeview.js", import.meta.url), "utf8");

test("mobile code detail state targets the outer modal controller", () => {
  assert.match(html, /id="code-modal"/);
  assert.match(feature, /\$\("code-modal"\)\.classList\.add\("detail"\)/);
  assert.match(css, /#code-modal\.detail \.cv-nav\s*\{\s*display:\s*none;/);
  assert.match(css, /#code-modal\.detail \.cv-main\s*\{\s*display:\s*flex;/);
});

test("code tree icons use accessible state and stable vector masks", () => {
  assert.match(feature, /row\.setAttribute\("aria-expanded", String\(isOpen\)\)/);
  assert.match(feature, /caret\.classList\.toggle\("open", isOpen\)/);
  assert.match(feature, /caret\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(feature, /mark\.setAttribute\("aria-hidden", "true"\)/);
  assert.doesNotMatch(feature, /caret\.textContent\s*=/);
  assert.doesNotMatch(feature, /mark\.textContent\s*=/);
  assert.match(css, /\.cv-caret\s*\{[^}]*-webkit-mask:/s);
  assert.match(css, /\.cv-caret\s*\{[^}]*opacity:\s*\.7;[^}]*stroke-width='1\.8'[^}]*14px 14px/s);
  assert.match(css, /\.cv-caret\.open\s*\{\s*transform:\s*rotate\(90deg\)/);
  assert.match(css, /\.cv-file-mark\s*\{[^}]*-webkit-mask:/s);
});
