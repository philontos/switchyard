import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import {
  descriptorMatchesPeer,
  discoveryPorts,
  isNodeDescriptor,
  probeSwitchyardPeer,
  sameLogin,
  trustedServeIdentity,
  upsertTailscaleHost,
  type SwitchyardNodeDescriptor,
} from "./peering.ts";
import { parseTailscaleStatus, type TailscalePeer } from "./tailscale.ts";

const descriptor: SwitchyardNodeDescriptor = {
  protocol: "switchyard-node",
  protocol_version: 1,
  instance_id: "abc12345",
  name: "dev-b",
  capabilities: ["tailscale-discovery-v1"],
  tailscale: {
    id: "node-b",
    dns_name: "dev-b.example.ts.net",
    ips: ["100.2.3.4"],
    login_name: "me@example.com",
    serve_port: 14500,
  },
  ssh: {
    user: "phil",
    port: 22,
    public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM7GQK8DgI1U7mFQ2o86vE4r5C2cndummyvalue12345 switchyard-node:abc12345",
    tdsp_bin: "/Users/phil/.task-dispatcher/bin/tdsp",
  },
};

const peer: TailscalePeer = {
  id: "node-b",
  userId: "1",
  loginName: "me@example.com",
  hostName: "dev-b",
  dnsName: "dev-b.example.ts.net",
  os: "macOS",
  ips: ["100.2.3.4"],
  online: true,
  active: false,
  connection: "idle",
  endpoint: null,
  relay: null,
  peerRelay: null,
};

test("discovery uses the active Serve port, then the default HTTPS port", () => {
  assert.deepEqual(discoveryPorts({ TDSP_TAILSCALE_PORT: "14500" }), [14500, 443]);
  assert.deepEqual(discoveryPorts({ TDSP_TAILSCALE_PORT: "443" }), [443]);
});

test("descriptor validation and peer binding reject identity substitution", () => {
  assert.equal(isNodeDescriptor(descriptor), true);
  assert.equal(descriptorMatchesPeer(descriptor, peer, "ME@example.com"), true);
  assert.equal(descriptorMatchesPeer({ ...descriptor, tailscale: { ...descriptor.tailscale, id: "other" } }, peer, "me@example.com"), false);
  assert.equal(sameLogin("Me@Example.com", "me@example.com"), true);
});

test("Serve identity is trusted only from loopback and the same Tailscale login", () => {
  const status = parseTailscaleStatus(JSON.stringify({
    BackendState: "Running",
    User: { 1: { LoginName: "me@example.com" } },
    Self: { ID: "self", UserID: 1, DNSName: "a.example.ts.net.", TailscaleIPs: ["100.1.1.1"] },
  }));
  assert.equal(trustedServeIdentity("127.0.0.1", "ME@example.com", status), true);
  assert.equal(trustedServeIdentity("192.168.1.5", "me@example.com", status), false);
  assert.equal(trustedServeIdentity("127.0.0.1", "friend@example.com", status), false);
});

test("peer probing accepts only a valid Switchyard descriptor", async () => {
  const found = await probeSwitchyardPeer(peer, [14500], async () => ({
    ok: true, status: 200, body: descriptor,
  }));
  assert.equal(found.ok, true);
  assert.equal(found.port, 14500);
  const bad = await probeSwitchyardPeer(peer, [14500], async () => ({
    ok: true, status: 200, body: { hello: "world" },
  }));
  assert.equal(bad.ok, false);
});

test("Tailscale pairing idempotently adopts a host by stable node identity", () => {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/old", dataDir: "/data" });
  const first = upsertTailscaleHost(db, descriptor);
  const second = upsertTailscaleHost(db, {
    ...descriptor,
    name: "renamed-b",
    tailscale: { ...descriptor.tailscale, ips: ["100.9.8.7"] },
  });
  assert.equal(first.id, second.id);
  assert.equal(second.name, "renamed-b");
  assert.equal(second.target, "phil@100.9.8.7");
  assert.equal(second.managed_ssh, 1);
  assert.equal(second.connection_source, "tailscale");
  assert.equal((db.prepare("SELECT count(*) AS n FROM hosts").get() as { n: number }).n, 1);
});

test("Tailscale pairing adopts a pre-existing manual MagicDNS host", () => {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/old", dataDir: "/data" });
  const manual = db.prepare(
    "INSERT INTO hosts (name,target,kind,connection_source,status) VALUES (?,?,?,'manual','online')",
  ).run("old name", "phil@dev-b.example.ts.net", "ssh");
  const connected = upsertTailscaleHost(db, descriptor);
  assert.equal(connected.id, Number(manual.lastInsertRowid));
  assert.equal(connected.target, "phil@100.2.3.4");
  assert.equal(connected.node_id, "abc12345");
  assert.equal(connected.status, "unknown");
  assert.equal(connected.ssh_ready, null);
  assert.equal((db.prepare("SELECT count(*) AS n FROM hosts").get() as { n: number }).n, 1);
});
