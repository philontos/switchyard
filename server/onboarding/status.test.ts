import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import type { TailscaleStatus } from "../network/tailscale.ts";
import {
  deriveOnboardingStatus,
  onboardingPorts,
  recordMobileCheckin,
  type OnboardingFacts,
} from "./status.ts";

function tailscale(overrides: Partial<TailscaleStatus> = {}): TailscaleStatus {
  return {
    available: true,
    state: "running",
    version: "1.0",
    binary: "tailscale",
    backendState: "Running",
    authUrl: null,
    tailnet: "me@example.com",
    magicDnsSuffix: "example.ts.net",
    magicDnsEnabled: true,
    certDomains: ["dev-a.example.ts.net"],
    health: [],
    self: {
      id: "node-a",
      userId: "1",
      loginName: "me@example.com",
      hostName: "dev-a",
      dnsName: "dev-a.example.ts.net",
      os: "macOS",
      ips: ["100.1.2.3"],
      online: true,
      active: false,
      connection: "idle",
      endpoint: null,
      relay: null,
      peerRelay: null,
    },
    peers: [],
    error: null,
    ...overrides,
  };
}

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    instanceId: "abc12345",
    machineName: "dev-a",
    platform: "darwin",
    localPort: 4500,
    httpsPort: 443,
    tailscale: tailscale(),
    listener: {
      configured: true,
      https: true,
      funnel: false,
      proxies: ["http://127.0.0.1:4500"],
      otherHandlers: false,
    },
    serveError: null,
    magicDnsResolves: true,
    sshListening: true,
    power: {
      supported: true,
      source: "ac",
      model: "MacBookPro18,3",
      laptop: true,
      idle_sleep_minutes: 1,
      display_sleep_minutes: 10,
      display_can_sleep: true,
      keep_awake_enabled: true,
      keep_awake_active: true,
      state: "ready",
      lid: "clamshell-required",
      lid_closed: false,
    },
    hosts: [],
    mobileCheckin: null,
    ...overrides,
  };
}

test("onboarding directs an install when Tailscale is unavailable", () => {
  const status = deriveOnboardingStatus(facts({
    tailscale: tailscale({
      available: false,
      state: "unavailable",
      self: null,
      certDomains: null,
      error: "not installed",
    }),
    listener: null,
    magicDnsResolves: null,
  }));
  assert.equal(status.network.state, "tailscale-missing");
  assert.equal(status.network.serve.ready, false);
  assert.equal(status.phone.state, "blocked");
  assert.equal(status.recommended, "install-tailscale");
});

test("ready private Serve produces a clean phone QR target", () => {
  const status = deriveOnboardingStatus(facts());
  assert.equal(status.network.state, "ready");
  assert.equal(status.network.serve.url, "https://dev-a.example.ts.net");
  assert.equal(status.phone.url, "https://dev-a.example.ts.net/?onboarding=mobile");
  assert.equal(status.phone.qr_path, "/api/onboarding/mobile-qr.svg");
  assert.equal(status.phone.state, "ready-to-scan");
  assert.equal(status.recommended, "scan-phone");
});

test("mobile evidence and bilateral SSH readiness complete independent goals", () => {
  const status = deriveOnboardingStatus(facts({
    hosts: [{ ssh_ready: 1, tdsp_bin: "/home/me/tdsp", connection_source: "tailscale" }],
    mobileCheckin: {
      occurred_at: "2026-07-23 09:00:00",
      detail: JSON.stringify({ device: "iPhone" }),
    },
  }));
  assert.equal(status.phone.state, "verified");
  assert.equal(status.phone.device, "iPhone");
  assert.equal(status.fleet.state, "ready");
  assert.deepEqual(status.ready, { local: true, always_on: true, phone: true, fleet: true });
  assert.equal(status.recommended, "complete");
});

test("phone plus one computer is complete without requiring a fleet peer", () => {
  const status = deriveOnboardingStatus(facts({
    mobileCheckin: {
      occurred_at: "2026-07-23 09:00:00",
      detail: JSON.stringify({ device: "iPhone" }),
    },
  }));
  assert.equal(status.phone.state, "verified");
  assert.equal(status.fleet.state, "no-peers");
  assert.equal(status.ready.phone, true);
  assert.equal(status.ready.fleet, false);
  assert.equal(status.recommended, "complete");
});

test("pairing remains successful while SSH requires an OS action", () => {
  const status = deriveOnboardingStatus(facts({
    sshListening: false,
    hosts: [{ ssh_ready: 0, tdsp_bin: "/home/me/tdsp", connection_source: "tailscale" }],
    mobileCheckin: {
      occurred_at: "2026-07-23 09:00:00",
      detail: JSON.stringify({ device: "iPhone" }),
    },
  }));
  assert.equal(status.fleet.connected, 1);
  assert.equal(status.fleet.ssh_pending, 1);
  assert.equal(status.fleet.local_ssh.guidance, "macos-remote-login");
  assert.equal(status.fleet.state, "ssh-action");
  assert.equal(status.recommended, "enable-ssh");
});

test("an AC Mac that can idle-sleep is guided to the reversible keep-awake action", () => {
  const status = deriveOnboardingStatus(facts({
    power: {
      ...facts().power,
      keep_awake_enabled: false,
      keep_awake_active: false,
      state: "needs-action",
    },
  }));
  assert.equal(status.availability.display_can_sleep, true);
  assert.equal(status.availability.lid, "clamshell-required");
  assert.equal(status.ready.always_on, false);
  assert.equal(status.recommended, "enable-keep-awake");
});

test("onboarding port defaults are stable and accept an isolated profile", () => {
  assert.deepEqual(onboardingPorts({}), { localPort: 4500, httpsPort: 443 });
  assert.deepEqual(
    onboardingPorts({ PORT: "14500", TDSP_TAILSCALE_PORT: "15443" }),
    { localPort: 14500, httpsPort: 15443 },
  );
});

test("mobile check-in stores evidence, not a completion flag", () => {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/old", dataDir: "/data" });
  recordMobileCheckin(db, {
    login: "me@example.com",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
  });
  const row = db.prepare(
    "SELECT kind,detail,occurred_at FROM onboarding_events WHERE kind='mobile-checkin'",
  ).get() as { kind: string; detail: string; occurred_at: string };
  assert.equal(row.kind, "mobile-checkin");
  assert.match(row.detail, /iPhone/);
  assert.ok(row.occurred_at);
});
