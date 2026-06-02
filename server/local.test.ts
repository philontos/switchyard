import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCwd } from "./local.ts";

const HOME = "/Users/alice";

test("resolveCwd: empty/blank falls back to home", () => {
  assert.equal(resolveCwd("", HOME), HOME);
  assert.equal(resolveCwd("   ", HOME), HOME);
  assert.equal(resolveCwd(null, HOME), HOME);
  assert.equal(resolveCwd(undefined, HOME), HOME);
});

test("resolveCwd: a lone ~ expands to home", () => {
  assert.equal(resolveCwd("~", HOME), HOME);
  assert.equal(resolveCwd(" ~ ", HOME), HOME);
});

test("resolveCwd: ~/sub expands under home", () => {
  assert.equal(resolveCwd("~/proj", HOME), "/Users/alice/proj");
  assert.equal(resolveCwd("~/a/b", HOME), "/Users/alice/a/b");
});

test("resolveCwd: an absolute path is kept as-is", () => {
  assert.equal(resolveCwd("/tmp/work", HOME), "/tmp/work");
});

test("resolveCwd: a relative path resolves under home", () => {
  assert.equal(resolveCwd("work", HOME), "/Users/alice/work");
});
