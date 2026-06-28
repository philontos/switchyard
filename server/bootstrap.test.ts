import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverNode, renderWrapper, NODE_RUNGS, nodeLadderScript, bootstrapMachine } from "./bootstrap.ts";

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

test("nodeLadderScript is shared by the wrapper and bootstrap (same rungs)", () => {
  const s = nodeLadderScript();
  assert.match(s, /fnm env/);
  assert.match(s, /nvm\.sh/);
  // the generated wrapper embeds exactly this ladder
  assert.ok(renderWrapper({ appDir: "/app" }).includes(s));
});

// ---------- bootstrapMachine ----------
// One-time install orchestration: discover node, push source, npm install, write
// the wrapper to a fixed path, verify it runs. Ops are injected so the sequence is
// testable without a real ssh. Order matters: discover gates everything; a verified
// wrapper path is what the caller stores as the host's tdsp_bin.
function fakeBoot(over: Record<string, unknown> = {}) {
  const scripts: string[] = [];
  const pushes: { src: string; dest: string }[] = [];
  const env = {
    appSrcDir: "/local/app",
    home: "/home/me",
    run: async (script: string) => {
      scripts.push(script);
      // simulate: node ladder resolves, npm install ok, wrapper write ok, verify ok
      const ok = /node -v/.test(script) ? true : true;
      return { ok, stdout: /node -v/.test(script) ? "v22.0.0" : "OK" };
    },
    pushDir: async (src: string, dest: string) => {
      pushes.push({ src, dest });
    },
    ...over,
  };
  return { env, scripts, pushes };
}

test("bootstrapMachine installs to ~/.task-dispatcher and returns the verified bin path", async () => {
  const { env, pushes } = fakeBoot();
  const r = await bootstrapMachine(env);
  assert.equal(r.ok, true);
  assert.equal(r.binPath, "/home/me/.task-dispatcher/bin/tdsp");
  assert.equal(r.appDir, "/home/me/.task-dispatcher/app");
  assert.equal(r.nodeVersion, "v22.0.0");
  // the source was pushed to the app dir
  assert.deepEqual(pushes, [{ src: "/local/app", dest: "/home/me/.task-dispatcher/app" }]);
});

test("bootstrapMachine runs npm install in the app dir after pushing source", async () => {
  const { env, scripts } = fakeBoot();
  await bootstrapMachine(env);
  assert.ok(scripts.some((s) => /npm (ci|install)/.test(s) && s.includes("/home/me/.task-dispatcher/app")));
});

test("bootstrapMachine aborts (and never pushes) when no node can be found", async () => {
  const { env, pushes } = fakeBoot({
    run: async () => ({ ok: false, stdout: "" }), // nothing resolves node
  });
  const r = await bootstrapMachine(env);
  assert.equal(r.ok, false);
  assert.match(r.error || "", /node/i);
  assert.equal(pushes.length, 0, "don't push source to a machine we can't run on");
});

test("bootstrapMachine reports failure if the installed wrapper doesn't verify", async () => {
  // node discovery ok, but the final `tdsp list` verify fails
  let sawVerify = false;
  const { env } = fakeBoot({
    run: async (script: string) => {
      if (/node -v/.test(script)) return { ok: true, stdout: "v22.0.0" };
      if (/\/bin\/tdsp('| )?.*(list|version)/.test(script)) { sawVerify = true; return { ok: false, stdout: "" }; }
      return { ok: true, stdout: "OK" };
    },
  });
  const r = await bootstrapMachine(env);
  assert.equal(sawVerify, true, "it attempted to verify the wrapper");
  assert.equal(r.ok, false);
});
