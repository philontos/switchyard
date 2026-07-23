import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverNode,
  renderWrapper,
  NODE_RUNGS,
  nodeLadderScript,
  installPlan,
  applyInstall,
  profileInstallPlan,
  applyProfileInstall,
  bootstrapMachine,
} from "./bootstrap.ts";

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

test("renderWrapper can pin an isolated data root before tdsp starts", () => {
  const w = renderWrapper({ appDir: "/app", dataDir: "/home/me/.task-dispatcher/profiles/canary/data" });
  assert.match(w, /export TDSP_SOURCE_DIR="\$APP"/);
  assert.match(w, /export TDSP_BIN="\$0"/);
  assert.match(w, /export TASK_DISPATCHER_DATA_DIR='\/home\/me\/\.task-dispatcher\/profiles\/canary\/data'/);
});

test("nodeLadderScript is shared by the wrapper and bootstrap (same rungs)", () => {
  const s = nodeLadderScript();
  assert.match(s, /fnm env/);
  assert.match(s, /nvm\.sh/);
  // the generated wrapper embeds exactly this ladder
  assert.ok(renderWrapper({ appDir: "/app" }).includes(s));
});

// ---------- installPlan ----------
test("installPlan puts code at ~/.task-dispatcher/src and the wrapper execs it", () => {
  const p = installPlan("/home/me");
  assert.equal(p.src, "/home/me/.task-dispatcher/src");
  assert.equal(p.binPath, "/home/me/.task-dispatcher/bin/tdsp");
  assert.equal(p.localBin, "/home/me/.local/bin/tdsp");
  // the wrapper points at the canonical src pointer, NOT at the clone path directly,
  // so updating where src points needs no wrapper change
  assert.match(p.wrapper, /\/home\/me\/\.task-dispatcher\/src/);
  assert.match(p.wrapper, /exec node .*server\/tdsp\.ts/);
});

test("applyInstall symlinks src→clone and writes an executable wrapper (real fs)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-home-"));
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-clone-"));
  try {
    const p = applyInstall(home, clone);
    // src is a symlink pointing at the clone
    const src = path.join(home, ".task-dispatcher", "src");
    assert.equal(fs.lstatSync(src).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(src), path.resolve(clone));
    // the wrapper exists, is executable, and execs the src pointer
    const st = fs.statSync(p.binPath);
    assert.ok(st.mode & 0o100, "wrapper is executable");
    const w = fs.readFileSync(p.binPath, "utf8");
    assert.match(w, /\.task-dispatcher\/src/, "APP points at the src pointer");
    assert.match(w, /exec node .*server\/tdsp\.ts/, "execs the app");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  }
});

test("profileInstallPlan is isolated from every canonical install path", () => {
  const p = profileInstallPlan("/home/me", "tailscale-test");
  assert.equal(p.src, "/home/me/.task-dispatcher/profiles/tailscale-test/src");
  assert.equal(p.binPath, "/home/me/.task-dispatcher/profiles/tailscale-test/bin/tdsp");
  assert.equal(p.localBin, "/home/me/.local/bin/tdsp-tailscale-test");
  assert.equal(p.dataDir, "/home/me/.task-dispatcher/profiles/tailscale-test/data");
  assert.match(p.wrapper, /TASK_DISPATCHER_DATA_DIR/);
  assert.doesNotMatch(p.binPath, /\/\.task-dispatcher\/bin\/tdsp$/);
});

test("profileInstallPlan rejects path traversal and ambiguous names", () => {
  for (const name of ["../live", "UPPER", "has space", "", "-leading"]) {
    assert.throws(() => profileInstallPlan("/home/me", name), /profile/i);
  }
});

test("applyProfileInstall does not replace the canonical src or tdsp launcher", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-profile-home-"));
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-profile-clone-"));
  const canonicalSrc = path.join(home, ".task-dispatcher", "src");
  const canonicalBin = path.join(home, ".task-dispatcher", "bin", "tdsp");
  fs.mkdirSync(path.dirname(canonicalSrc), { recursive: true });
  fs.mkdirSync(path.dirname(canonicalBin), { recursive: true });
  fs.writeFileSync(canonicalSrc, "keep-src");
  fs.writeFileSync(canonicalBin, "keep-bin");
  try {
    const p = applyProfileInstall(home, clone, "canary");
    assert.equal(fs.readFileSync(canonicalSrc, "utf8"), "keep-src");
    assert.equal(fs.readFileSync(canonicalBin, "utf8"), "keep-bin");
    assert.equal(fs.readlinkSync(p.src), path.resolve(clone));
    assert.equal(fs.statSync(p.binPath).mode & 0o100, 0o100);
    assert.match(fs.readFileSync(p.binPath, "utf8"), /TASK_DISPATCHER_DATA_DIR/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  }
});

// ---------- bootstrapMachine (A-side one-click remote install) ----------
function fakeBoot(over: Record<string, unknown> = {}) {
  const scripts: string[] = [];
  const env = {
    home: "/home/me",
    originUrl: "git@github.com:me/switchyard.git",
    run: async (script: string) => {
      scripts.push(script);
      if (/node -v/.test(script)) return { ok: true, stdout: "v22.0.0" };
      if (/HAVECODE/.test(script)) return { ok: true, stdout: "REUSED\nHAVECODE" }; // src already present
      return { ok: true, stdout: "OK" };
    },
    ...over,
  };
  return { env, scripts };
}

test("bootstrapMachine returns the canonical src + verified wrapper path", async () => {
  const { env } = fakeBoot();
  const r = await bootstrapMachine(env);
  assert.equal(r.ok, true);
  assert.equal(r.binPath, "/home/me/.task-dispatcher/bin/tdsp");
  assert.equal(r.srcDir, "/home/me/.task-dispatcher/src");
  assert.equal(r.cloned, false, "reused the existing src");
});

test("bootstrapMachine reuses an existing src untouched — never pulls it", async () => {
  const { env, scripts } = fakeBoot();
  const r = await bootstrapMachine(env);
  assert.equal(r.cloned, false);
  assert.ok(!scripts.some((s) => /git pull/.test(s)), "must never pull a clone we don't own");
});

test("bootstrapMachine clones to src when the target has no code yet", async () => {
  const { env } = fakeBoot({
    run: async (script: string) => {
      if (/node -v/.test(script)) return { ok: true, stdout: "v22.0.0" };
      if (/HAVECODE/.test(script)) return { ok: true, stdout: "CLONED\nHAVECODE" };
      return { ok: true, stdout: "OK" };
    },
  });
  const r = await bootstrapMachine(env);
  assert.equal(r.ok, true);
  assert.equal(r.cloned, true, "src was absent → cloned fresh");
});

test("bootstrapMachine aborts (touching nothing) when no node can be found", async () => {
  const { env, scripts } = fakeBoot({ run: async () => ({ ok: false, stdout: "" }) });
  const r = await bootstrapMachine(env);
  assert.equal(r.ok, false);
  assert.match(r.error || "", /node/i);
  assert.ok(!scripts.some((s) => /git clone|npm install/.test(s)), "don't touch a machine we can't run on");
});

test("bootstrapMachine reports failure if the installed wrapper doesn't verify", async () => {
  let sawVerify = false;
  const { env } = fakeBoot({
    run: async (script: string) => {
      if (/node -v/.test(script)) return { ok: true, stdout: "v22.0.0" };
      if (/HAVECODE/.test(script)) return { ok: true, stdout: "REUSED\nHAVECODE" };
      if (/\/bin\/tdsp('| )?.*(list|version)/.test(script)) { sawVerify = true; return { ok: false, stdout: "" }; }
      return { ok: true, stdout: "OK" };
    },
  });
  const r = await bootstrapMachine(env);
  assert.equal(sawVerify, true, "it attempted to verify the wrapper");
  assert.equal(r.ok, false);
});
