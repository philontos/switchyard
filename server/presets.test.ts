import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDispatchPrompt, skillsLine } from "./presets.ts";

test("renderDispatchPrompt fills {vars}, blanks unknown", () => {
  const out = renderDispatchPrompt("用 {skill}\n标题: {title}\n{prompt}", { title: "T", prompt: "P" });
  assert.equal(out, "用 \n标题: T\nP");
});

test("skillsLine lists names, empty when none", () => {
  assert.equal(skillsLine(["a", "b"]), "\n\n本任务已带入 skills: a, b");
  assert.equal(skillsLine([]), "");
});
