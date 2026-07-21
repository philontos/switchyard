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
