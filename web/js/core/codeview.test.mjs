import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFileTree, sortedTreeChildren, diffLineKind, classifyCodePath,
  codeLineCount, canHighlightCode, parseStructuredJson,
  MAX_HIGHLIGHT_BYTES, MAX_HIGHLIGHT_LINES, MAX_STRUCTURED_JSON_BYTES,
} from "./codeview.js";

test("buildFileTree turns flat Git paths into stable directory/file nodes", () => {
  const root = buildFileTree(["README.md", "src/z.ts", "src/lib/a.ts", "src/a.ts"]);
  const top = sortedTreeChildren(root);
  assert.deepEqual(top.dirs.map((x) => x.name), ["src"]);
  assert.deepEqual(top.files.map((x) => x.name), ["README.md"]);
  const src = sortedTreeChildren(top.dirs[0]);
  assert.deepEqual(src.dirs.map((x) => x.name), ["lib"]);
  assert.deepEqual(src.files.map((x) => x.name), ["a.ts", "z.ts"]);
});

test("diffLineKind keeps file headers distinct from additions/deletions", () => {
  assert.equal(diffLineKind("+++ b/a.ts"), "header");
  assert.equal(diffLineKind("--- a/a.ts"), "header");
  assert.equal(diffLineKind("+const a = 1"), "add");
  assert.equal(diffLineKind("-const a = 0"), "del");
  assert.equal(diffLineKind("@@ -1 +1 @@"), "hunk");
  assert.equal(diffLineKind("diff --git a/a b/a"), "meta");
});

test("classifyCodePath uses deterministic filename and extension mappings", () => {
  assert.deepEqual(classifyCodePath("src/view.tsx"), {
    kind: "code", language: "typescript", label: "TypeScript",
  });
  assert.deepEqual(classifyCodePath("ops/Dockerfile"), {
    kind: "code", language: "dockerfile", label: "Dockerfile",
  });
  assert.equal(classifyCodePath("ops/Dockerfile.dev").language, "dockerfile");
  assert.equal(classifyCodePath(".env.local").language, "bash");
  assert.equal(classifyCodePath("README").language, "markdown");
  assert.deepEqual(classifyCodePath("CMakeLists.txt"), {
    kind: "code", language: "cmake", label: "CMake",
  });
  assert.deepEqual(classifyCodePath("config/app.toml"), {
    kind: "code", language: "ini", label: "INI / TOML",
  });
  assert.deepEqual(classifyCodePath("assets/unknown.blob"), {
    kind: "code", language: "plaintext", label: "Text",
  });
});

test("only strict JSON files opt into the structured view", () => {
  assert.equal(classifyCodePath("package.json").kind, "json");
  assert.equal(classifyCodePath("map.GEOJSON").kind, "json");
  assert.equal(classifyCodePath("settings.jsonc").kind, "code");
  assert.equal(classifyCodePath("events.jsonl").kind, "code");
});

test("codeLineCount matches the visible source gutter", () => {
  assert.equal(codeLineCount(""), 1);
  assert.equal(codeLineCount("one"), 1);
  assert.equal(codeLineCount("one\ntwo"), 2);
  assert.equal(codeLineCount("one\ntwo\n"), 2);
});

test("syntax highlighting has deterministic size, line, and language fallbacks", () => {
  assert.equal(canHighlightCode("const x = 1", MAX_HIGHLIGHT_BYTES, "javascript"), true);
  assert.equal(canHighlightCode("const x = 1", MAX_HIGHLIGHT_BYTES + 1, "javascript"), false);
  assert.equal(canHighlightCode("plain", 5, "plaintext"), false);
  const exactLinesWithFinalNewline = "x\n".repeat(MAX_HIGHLIGHT_LINES);
  assert.equal(canHighlightCode(exactLinesWithFinalNewline, exactLinesWithFinalNewline.length, "javascript"), true);
  const tooManyLines = `${"x\n".repeat(MAX_HIGHLIGHT_LINES)}x`;
  assert.equal(canHighlightCode(tooManyLines, tooManyLines.length, "javascript"), false);
});

test("structured JSON parsing is strict and size-bounded", () => {
  assert.deepEqual(parseStructuredJson('{"name":"switchyard","ok":true}', 31), {
    ok: true, value: { name: "switchyard", ok: true },
  });
  assert.deepEqual(parseStructuredJson("{ trailing: true }", 18), { ok: false, reason: "invalid" });
  assert.deepEqual(parseStructuredJson("{}", MAX_STRUCTURED_JSON_BYTES + 1), {
    ok: false, reason: "tooLarge",
  });
});
