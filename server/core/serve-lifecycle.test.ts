import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ServeLifecycle,
  serveOptionsFromCommand,
  serveOptionsToArgs,
  serveOptionsToCommand,
} from "./serve-lifecycle.ts";

interface FakeProcess {
  alive: boolean;
  command: string;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-serve-lifecycle-"));
  const processes = new Map<number, FakeProcess>();
  let tokenNumber = 0;
  const signals: Array<[number, NodeJS.Signals]> = [];

  function lifecycle(
    dataDir: string,
    pid: number,
    stopTimeoutMs = 100,
    findLegacyProcesses?: () => Array<{ pid: number; command: string }>,
  ) {
    return new ServeLifecycle({
      dataDir,
      instance: path.basename(dataDir),
      pid,
      token: () => `token${String(++tokenNumber).padStart(8, "0")}`,
      setProcessTitle: (title) => {
        processes.set(pid, { alive: true, command: title });
      },
      inspectProcess: (target) => processes.get(target) ?? { alive: false, command: "" },
      findLegacyProcesses,
      signalProcess: (target, signal) => {
        signals.push([target, signal]);
        const existing = processes.get(target);
        if (existing) existing.alive = false;
      },
      sleep: async () => {},
      manageCurrentProcessSignals: false,
      stopTimeoutMs,
      now: () => new Date("2026-07-23T10:00:00.000Z"),
    });
  }

  return {
    root,
    processes,
    signals,
    lifecycle,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("serve options have one stable restart argv and display command", () => {
  const options = {
    host: "127.0.0.1",
    hostCidr: "10.10.0.0/24",
    port: 14500,
    tailscale: true,
    tailscaleHttpsPort: 15443,
  };
  assert.deepEqual(serveOptionsToArgs(options), [
    "serve",
    "--host",
    "127.0.0.1",
    "--host-cidr",
    "10.10.0.0/24",
    "--port",
    "14500",
    "--tailscale",
    "--tailscale-port",
    "15443",
  ]);
  assert.equal(
    serveOptionsToCommand(options),
    "tdsp serve --host 127.0.0.1 --host-cidr 10.10.0.0/24 --port 14500 --tailscale --tailscale-port 15443",
  );
});

test("pre-lifecycle serve command recovery understands the supported launch flags", () => {
  assert.deepEqual(
    serveOptionsFromCommand(
      "node /app/server/tdsp.ts serve --host-cidr 10.10.0.0/24 --port=14500 --tailscale --tailscale-port 15443",
    ),
    {
      hostCidr: "10.10.0.0/24",
      port: 14500,
      tailscale: true,
      tailscaleHttpsPort: 15443,
    },
  );
  assert.deepEqual(serveOptionsFromCommand("node /app/server/tdsp.ts serve"), { port: 4500 });
  assert.equal(serveOptionsFromCommand("node /app/server/tdsp.ts list"), null);
  assert.equal(serveOptionsFromCommand("node /app/server/tdsp.ts serve --port nope"), null);
});

test("claim records starting, markReady records running, and release preserves restart config", () => {
  const f = fixture();
  try {
    const dataDir = path.join(f.root, "default");
    const manager = f.lifecycle(dataDir, 101);
    const lease = manager.claim({ port: 14500, hostCidr: "10.10.0.0/24" });

    const starting = manager.status();
    assert.equal(starting.state, "starting");
    assert.equal(starting.running, true);
    assert.equal(starting.pid, 101);

    lease.markReady();
    const running = manager.status();
    assert.equal(running.state, "running");
    assert.deepEqual(running.options, { hostCidr: "10.10.0.0/24", port: 14500 });

    lease.release();
    const stopped = manager.status();
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.running, false);
    assert.deepEqual(stopped.options, { hostCidr: "10.10.0.0/24", port: 14500 });
    assert.match(stopped.command || "", /14500/);
  } finally {
    f.cleanup();
  }
});

test("different profile data dirs have independent lifecycle truth", () => {
  const f = fixture();
  try {
    const canonical = f.lifecycle(path.join(f.root, "canonical"), 101);
    const canary = f.lifecycle(path.join(f.root, "canary"), 202);
    const canonicalLease = canonical.claim({ port: 4500 });
    canonicalLease.markReady();
    const canaryLease = canary.claim({ port: 14500 });
    canaryLease.markReady();

    assert.equal(canonical.status().pid, 101);
    assert.equal(canonical.status().options?.port, 4500);
    assert.equal(canary.status().pid, 202);
    assert.equal(canary.status().options?.port, 14500);

    canaryLease.release();
    assert.equal(canonical.status().running, true);
    assert.equal(canary.status().running, false);
    canonicalLease.release();
  } finally {
    f.cleanup();
  }
});

test("a second start cannot claim an instance whose exact managed process is alive", () => {
  const f = fixture();
  try {
    const dataDir = path.join(f.root, "default");
    const first = f.lifecycle(dataDir, 101);
    const lease = first.claim({ port: 4500 });
    lease.markReady();

    const second = f.lifecycle(dataDir, 202);
    assert.throws(() => second.claim({ port: 4500 }), /already running/i);
    assert.equal(first.status().pid, 101);
    lease.release();
  } finally {
    f.cleanup();
  }
});

test("stop signals only the exact token-identified process and removes its live record", async () => {
  const f = fixture();
  try {
    const dataDir = path.join(f.root, "default");
    const owner = f.lifecycle(dataDir, 101);
    const lease = owner.claim({ port: 4500 });
    lease.markReady();

    const controller = f.lifecycle(dataDir, 202);
    const result = await controller.stop();
    assert.deepEqual(f.signals, [[101, "SIGTERM"]]);
    assert.equal(result.ok, true);
    assert.equal(result.stopped, true);
    assert.equal(controller.status().state, "stopped");
    assert.equal(controller.status().options?.port, 4500);
    lease.release();
  } finally {
    f.cleanup();
  }
});

test("a reused PID with a different command is stale and is never signalled", async () => {
  const f = fixture();
  try {
    const dataDir = path.join(f.root, "default");
    const owner = f.lifecycle(dataDir, 101);
    const lease = owner.claim({ port: 4500 });
    lease.markReady();

    f.processes.set(101, { alive: true, command: "unrelated-important-process" });
    const controller = f.lifecycle(dataDir, 202);
    assert.equal(controller.status().state, "stale");
    const result = await controller.stop();
    assert.equal(result.ok, true);
    assert.equal(result.alreadyStopped, true);
    assert.deepEqual(f.signals, []);
    assert.equal(controller.status().state, "stopped");
    lease.release();
  } finally {
    f.cleanup();
  }
});

test("a new start atomically retires a dead process record", () => {
  const f = fixture();
  try {
    const dataDir = path.join(f.root, "default");
    const first = f.lifecycle(dataDir, 101);
    first.claim({ port: 4500 }).markReady();
    f.processes.set(101, { alive: false, command: "" });

    const second = f.lifecycle(dataDir, 202);
    const lease = second.claim({ port: 14500 });
    lease.markReady();
    assert.equal(second.status().pid, 202);
    assert.equal(second.status().options?.port, 14500);
    lease.release();
  } finally {
    f.cleanup();
  }
});

test("a pre-lifecycle tdsp process is reported and its launch options survive the one-time stop", async () => {
  const f = fixture();
  try {
    const dataDir = path.join(f.root, "default");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "dispatcher.db"), "");
    const command = "node /switchyard/server/tdsp.ts serve --port 14500 --tailscale --tailscale-port 15443";
    f.processes.set(77, { alive: true, command });
    const legacy = () => f.processes.get(77)?.alive ? [{ pid: 77, command }] : [];
    const manager = f.lifecycle(dataDir, 202, 100, legacy);

    const status = manager.status();
    assert.equal(status.state, "legacy");
    assert.equal(status.running, true);
    assert.equal(status.pid, 77);
    assert.deepEqual(status.options, { port: 14500, tailscale: true, tailscaleHttpsPort: 15443 });
    assert.throws(() => manager.claim({ port: 4500 }), /already running without a lifecycle record/i);

    const result = await manager.stop();
    assert.equal(result.ok, true);
    assert.equal(result.stopped, true);
    assert.deepEqual(f.signals, [[77, "SIGTERM"]]);
    assert.equal(manager.status().state, "stopped");
    assert.deepEqual(manager.status().options, { port: 14500, tailscale: true, tailscaleHttpsPort: 15443 });
  } finally {
    f.cleanup();
  }
});
