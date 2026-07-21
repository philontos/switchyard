import test from "node:test";
import assert from "node:assert/strict";
import { buildFileTree, sortedTreeChildren, diffLineKind } from "./codeview.js";

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
