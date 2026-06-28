import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverNode, renderWrapper, NODE_RUNGS } from "./bootstrap.ts";

// A fake probe simulates a machine: `works(script)` decides whether that rung's
// shell snippet would resolve a node. The discovery ladder must pick the FIRST
// rung that works, regardless of machine flavor — that's the compatibility goal.
function machine(works: (script: string) => boolean, version = "v22.0.0") {
  return async (script: string) => ({ ok: works(script), stdout: works(script) ? version : "" });
}

test("discoverNode picks 'path' when node is already on the bare PATH", async () => {
  const probe = machine(() => true); // anything resolves → the first rung (path) wins
  const r = await discoverNode(probe);
  assert.equal(r.ok, true);
  assert.equal(r.strategy, "path");
  assert.equal(r.version, "v22.0.0");
});

test("discoverNode falls through to fnm on an fnm-only machine", async () => {
  const probe = machine((s) => s.includes("fnm env")); // only the fnm rung works
  const r = await discoverNode(probe);
  assert.equal(r.ok, true);
  assert.equal(r.strategy, "fnm");
});

test("discoverNode falls through to nvm on an nvm-only machine (rc won't load non-interactively)", async () => {
  const probe = machine((s) => s.includes("nvm.sh"));
  const r = await discoverNode(probe);
  assert.equal(r.ok, true);
  assert.equal(r.strategy, "nvm");
});

test("discoverNode reports failure honestly when no rung resolves a node", async () => {
  const probe = machine(() => false);
  const r = await discoverNode(probe);
  assert.equal(r.ok, false);
  assert.equal(r.strategy, undefined);
});

test("discoverNode tries a manual override FIRST and uses it when it works", async () => {
  const probe = machine((s) => s.includes("/opt/custom/node/bin"));
  const r = await discoverNode(probe, 'export PATH=/opt/custom/node/bin:$PATH');
  assert.equal(r.ok, true);
  assert.equal(r.strategy, "override");
});

test("discoverNode falls through past a broken override to a working rung", async () => {
  const probe = machine((s) => s.includes("fnm env")); // override is wrong; fnm works
  const r = await discoverNode(probe, 'export PATH=/nonexistent:$PATH');
  assert.equal(r.ok, true);
  assert.equal(r.strategy, "fnm");
});

// the ladder is shared between discovery and the generated wrapper, so a rung
// that bootstrap verified is exactly one the wrapper will retry at runtime.
test("NODE_RUNGS starts with the bare-PATH rung and includes fnm + nvm", async () => {
  assert.equal(NODE_RUNGS[0].name, "path");
  const names = NODE_RUNGS.map((r) => r.name);
  assert.ok(names.includes("fnm"));
  assert.ok(names.includes("nvm"));
});

test("renderWrapper embeds the app dir, the node ladder, an honest failure, and the exec line", () => {
  const w = renderWrapper({ appDir: "/home/me/.task-dispatcher/app" });
  assert.match(w, /^#!/, "has a shebang");
  assert.match(w, /\/home\/me\/\.task-dispatcher\/app/);
  assert.match(w, /fnm env/, "self-discovering: retries the fnm rung at runtime");
  assert.match(w, /nvm\.sh/, "retries the nvm rung at runtime");
  assert.match(w, /exec node .*server\/tdsp\.ts/, "execs the app, passing args through");
  assert.match(w, /no usable node/i, "fails honestly instead of a cryptic command-not-found");
});

test("renderWrapper places a manual override ahead of the auto rungs", () => {
  const w = renderWrapper({ appDir: "/app", override: 'export PATH=/opt/custom/node/bin:$PATH' });
  assert.ok(w.indexOf("/opt/custom/node/bin") < w.indexOf("fnm env"), "override is tried before fnm");
});
