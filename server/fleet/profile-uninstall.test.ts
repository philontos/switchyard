import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServeStatus } from "../core/serve-lifecycle.ts";
import { recordOwnedServeRoute } from "../network/serve-ownership.ts";
import { uninstallProfile } from "./profile-uninstall.ts";

function fixture(profile = "canary") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-uninstall-home-"));
  const root = path.join(home, ".task-dispatcher", "profiles", profile);
  const dataRoot = path.join(root, "data");
  const instance = "abc12345";
  const dataDir = path.join(dataRoot, instance);
  const binPath = path.join(root, "bin", "tdsp");
  const localBin = path.join(home, ".local", "bin", `tdsp-${profile}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.mkdirSync(path.dirname(localBin), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "controller-id"), `${instance}\n`);
  fs.writeFileSync(path.join(dataDir, "dispatcher.db"), "important profile data");
  fs.writeFileSync(binPath, "#!/bin/sh\n");
  fs.symlinkSync(binPath, localBin);

  const stopped: ServeStatus = {
    state: "stopped",
    running: false,
    instance,
    dataDir,
    pid: null,
    startedAt: null,
    readyAt: null,
    options: null,
    command: null,
  };
  const networkCalls: Array<[number, number]> = [];
  return {
    home,
    root,
    dataDir,
    binPath,
    localBin,
    profile,
    stopped,
    networkCalls,
    deps: {
      home,
      serveStatus: () => stopped,
      networkOff: async (httpsPort: number, localPort: number) => {
        networkCalls.push([httpsPort, localPort]);
        return { ok: true };
      },
      now: () => new Date("2026-07-23T14:00:00.000Z"),
      token: () => "deadbeef",
    },
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

test("uninstall archives the whole stopped profile, removes only its launcher, and cleans its Tailscale route", async () => {
  const f = fixture();
  try {
    const result = await uninstallProfile(f.profile, {}, {
      ...f.deps,
      serveStatus: () => ({
        ...f.stopped,
        options: { port: 14500, tailscale: true, tailscaleHttpsPort: 15443 },
        command: "tdsp serve --port 14500 --tailscale --tailscale-port 15443",
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.purged, false);
    assert.equal(result.launcherRemoved, true);
    assert.equal(result.networkRoutesRemoved, 1);
    assert.deepEqual(f.networkCalls, [[15443, 14500]]);
    assert.equal(fs.existsSync(f.root), false);
    assert.equal(fs.lstatSync(f.localBin, { throwIfNoEntry: false }), undefined);
    assert.ok(result.archivedAt);
    assert.equal(
      fs.readFileSync(path.join(result.archivedAt!, "data", "abc12345", "dispatcher.db"), "utf8"),
      "important profile data",
    );
  } finally {
    f.cleanup();
  }
});

test("uninstall refuses a running profile before touching its data, launcher, or network", async () => {
  const f = fixture();
  try {
    const result = await uninstallProfile(f.profile, {}, {
      ...f.deps,
      serveStatus: () => ({ ...f.stopped, state: "running", running: true, pid: 77 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "running");
    assert.equal(result.pid, 77);
    assert.equal(fs.existsSync(f.root), true);
    assert.equal(fs.lstatSync(f.localBin).isSymbolicLink(), true);
    assert.deepEqual(f.networkCalls, []);
  } finally {
    f.cleanup();
  }
});

test("uninstall re-checks and refuses a profile that starts during cleanup", async () => {
  const f = fixture();
  try {
    let checks = 0;
    const result = await uninstallProfile(f.profile, {}, {
      ...f.deps,
      serveStatus: () => {
        checks++;
        return checks === 1
          ? f.stopped
          : { ...f.stopped, state: "starting", running: true, pid: 88 };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "running");
    assert.equal(result.pid, 88);
    assert.equal(fs.existsSync(f.root), true);
    assert.equal(fs.lstatSync(f.localBin).isSymbolicLink(), true);
  } finally {
    f.cleanup();
  }
});

test("uninstall aborts without moving data when its exact Tailscale route cannot be safely removed", async () => {
  const f = fixture();
  try {
    const result = await uninstallProfile(f.profile, {}, {
      ...f.deps,
      serveStatus: () => ({
        ...f.stopped,
        options: { port: 14500, tailscale: true, tailscaleHttpsPort: 15443 },
      }),
      networkOff: async (httpsPort, localPort) => {
        f.networkCalls.push([httpsPort, localPort]);
        return { ok: false, error: "route belongs to another handler" };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "networkCleanup");
    assert.match(result.message || "", /another handler/);
    assert.equal(fs.existsSync(f.root), true);
    assert.equal(fs.lstatSync(f.localBin).isSymbolicLink(), true);
  } finally {
    f.cleanup();
  }
});

test("uninstall leaves a repointed Tailscale listener untouched instead of blocking profile removal", async () => {
  const f = fixture();
  try {
    recordOwnedServeRoute(f.dataDir, { httpsPort: 15443, localPort: 14500 });
    const result = await uninstallProfile(f.profile, {}, {
      ...f.deps,
      networkOff: async () => ({
        ok: false,
        reason: "mismatch",
        error: "listener now points to another handler",
      }),
    });
    assert.equal(result.ok, true);
    assert.match(result.warnings?.join("\n") || "", /no longer points to this profile/);
    assert.equal(fs.existsSync(f.root), false);
  } finally {
    f.cleanup();
  }
});

test("uninstall cleans a previously owned Tailscale route even when the latest launch was plain HTTP", async () => {
  const f = fixture();
  try {
    recordOwnedServeRoute(f.dataDir, { httpsPort: 15443, localPort: 14500 });
    const result = await uninstallProfile(f.profile, {}, {
      ...f.deps,
      serveStatus: () => ({
        ...f.stopped,
        options: { port: 14500 },
        command: "tdsp serve --port 14500",
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(f.networkCalls, [[15443, 14500]]);
  } finally {
    f.cleanup();
  }
});

test("uninstall --purge permanently removes the archived profile", async () => {
  const f = fixture();
  try {
    const result = await uninstallProfile(f.profile, { purge: true }, f.deps);
    assert.equal(result.ok, true);
    assert.equal(result.purged, true);
    assert.equal(result.archivedAt, null);
    assert.equal(fs.existsSync(f.root), false);
    const archiveRoot = path.join(f.home, ".task-dispatcher", "uninstalled-profiles");
    assert.deepEqual(fs.readdirSync(archiveRoot), []);
  } finally {
    f.cleanup();
  }
});

test("uninstall leaves a user-owned command at the convenience path untouched", async () => {
  const f = fixture();
  try {
    fs.unlinkSync(f.localBin);
    fs.writeFileSync(f.localBin, "user command");
    const result = await uninstallProfile(f.profile, {}, f.deps);
    assert.equal(result.ok, true);
    assert.equal(result.launcherRemoved, false);
    assert.match(result.warnings?.join("\n") || "", /not this profile's managed symlink/);
    assert.equal(fs.readFileSync(f.localBin, "utf8"), "user command");
  } finally {
    f.cleanup();
  }
});

test("uninstall is idempotent and can remove the matching dangling launcher", async () => {
  const f = fixture();
  try {
    fs.rmSync(f.root, { recursive: true, force: true });
    assert.equal(fs.lstatSync(f.localBin).isSymbolicLink(), true);
    const result = await uninstallProfile(f.profile, {}, f.deps);
    assert.equal(result.ok, true);
    assert.equal(result.alreadyAbsent, true);
    assert.equal(result.launcherRemoved, true);
    assert.equal(fs.lstatSync(f.localBin, { throwIfNoEntry: false }), undefined);
  } finally {
    f.cleanup();
  }
});

test("uninstall rejects unsafe profile names without resolving them below the home directory", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-uninstall-invalid-"));
  try {
    const result = await uninstallProfile("../default", {}, {
      home,
      networkOff: async () => ({ ok: true }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalidProfile");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
