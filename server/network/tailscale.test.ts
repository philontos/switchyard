import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseTailscale,
  configureTailscalePeerRelay,
  disableTailscalePeerRelay,
  disableTailscaleServe,
  inspectTailscaleServePort,
  parseTailscalePing,
  parseTailscaleStatus,
  setupTailscale,
  tailscaleStatus,
  type TailscaleCommand,
} from "./tailscale.ts";

function result(stdout = "", ok = true, stderr = "") {
  return { ok, stdout, stderr, code: ok ? 0 : 1 };
}

const running = JSON.stringify({
  Version: "1.96.4",
  BackendState: "Running",
  CertDomains: ["dev-a.example.ts.net"],
  TailscaleIPs: ["100.1.2.3"],
  Self: {
    ID: "self",
    HostName: "dev-a",
    DNSName: "dev-a.example.ts.net.",
    OS: "macOS",
    TailscaleIPs: ["100.1.2.3"],
    Online: true,
    Active: false,
    Relay: "hkg",
  },
  CurrentTailnet: {
    Name: "me@example.com",
    MagicDNSSuffix: "example.ts.net",
    MagicDNSEnabled: true,
  },
  Peer: {
    one: {
      ID: "one",
      HostName: "dev-b",
      DNSName: "dev-b.example.ts.net.",
      OS: "linux",
      TailscaleIPs: ["100.4.5.6"],
      Online: true,
      Active: true,
      CurAddr: "1.2.3.4:41641",
      Relay: "hkg",
    },
    two: {
      ID: "two",
      HostName: "dev-c",
      DNSName: "dev-c.example.ts.net.",
      OS: "linux",
      TailscaleIPs: ["100.7.8.9"],
      Online: true,
      Active: true,
      PeerRelay: "100.9.9.9:40000:vni:1",
      Relay: "lax",
    },
  },
});

function serveConfig(port: number, localPort: number, funnel = false) {
  const hostPort = `dev-a.example.ts.net:${port}`;
  return JSON.stringify({
    TCP: { [port]: { HTTPS: true } },
    Web: {
      [hostPort]: {
        Handlers: { "/": { Proxy: `http://127.0.0.1:${localPort}` } },
      },
    },
    ...(funnel ? { AllowFunnel: { [hostPort]: true } } : {}),
  });
}

test("parseTailscaleStatus projects a stable, private status shape", () => {
  const status = parseTailscaleStatus(running, "/bin/tailscale");
  assert.equal(status.available, true);
  assert.equal(status.state, "running");
  assert.equal(status.self?.dnsName, "dev-a.example.ts.net");
  assert.equal(status.tailnet, "me@example.com");
  assert.equal(status.peers[0].connection, "direct");
  assert.equal(status.peers[1].connection, "peer-relay");
  assert.equal("PublicKey" in (status.self as any), false);
});

test("tailscaleStatus reports an absent binary without throwing", async () => {
  const command: TailscaleCommand = async () => ({
    ok: false, stdout: "", stderr: "ENOENT", code: null, notFound: true,
  });
  const status = await tailscaleStatus(command, "tailscale");
  assert.equal(status.available, false);
  assert.equal(status.state, "unavailable");
  assert.match(status.error || "", /install/i);
});

test("setupTailscale returns HTTPS consent immediately when Serve is not enabled", async () => {
  const calls: string[][] = [];
  const command: TailscaleCommand = async (args) => {
    calls.push(args);
    if (args[0] === "status") {
      return result(JSON.stringify({
        BackendState: "Running",
        CertDomains: null,
        Self: { ID: "node-123", DNSName: "dev-a.example.ts.net." },
      }));
    }
    return result();
  };
  const setup = await setupTailscale({ localPort: 14500, httpsPort: 14500 }, command);
  assert.equal(setup.ok, false);
  assert.equal(setup.serveConsentUrl, "https://login.tailscale.com/f/serve?node=node-123");
  assert.equal(calls.some((args) => args[0] === "serve"), false);
});

test("setupTailscale configures only its requested HTTPS listener", async () => {
  const calls: string[][] = [];
  const command: TailscaleCommand = async (args) => {
    calls.push(args);
    if (args[0] === "status") return result(running);
    if (args[0] === "serve" && args[1] === "status") return result("{}");
    if (args[0] === "serve") return result("Serve started");
    return result();
  };
  const setup = await setupTailscale({ localPort: 14500, httpsPort: 14500 }, command, "tailscale");
  assert.equal(setup.ok, true);
  assert.equal(setup.url, "https://dev-a.example.ts.net:14500");
  assert.deepEqual(calls.find((args) => args[0] === "serve" && args[1] !== "status"), [
    "serve", "--bg", "--yes", "--https=14500", "http://127.0.0.1:14500",
  ]);
  assert.equal(calls.some((args) => args.includes("reset")), false);
  assert.equal(calls.some((args) => args[0] === "funnel"), false);
});

test("setupTailscale runs tailscale up when the node needs login", async () => {
  let statusCalls = 0;
  const needsLogin = JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.example/a/1" });
  const calls: string[][] = [];
  const command: TailscaleCommand = async (args) => {
    calls.push(args);
    if (args[0] === "status") return result(statusCalls++ === 0 ? needsLogin : running);
    if (args[0] === "up") return result("logged in");
    if (args[0] === "serve" && args[1] === "status") return result("{}");
    if (args[0] === "serve") return result("ok");
    return result();
  };
  const setup = await setupTailscale({ localPort: 4500 }, command, "tailscale");
  assert.equal(setup.ok, true);
  assert.equal(calls.some((args) => args[0] === "up"), true);
});

test("disableTailscaleServe removes one listener without resetting all Serve state", async () => {
  const calls: string[][] = [];
  const command: TailscaleCommand = async (args) => {
    calls.push(args);
    if (args[0] === "serve" && args[1] === "status") return result(serveConfig(14500, 14500));
    return result();
  };
  assert.deepEqual(await disableTailscaleServe(14500, 14500, command), { ok: true });
  assert.deepEqual(calls, [
    ["serve", "status", "--json"],
    ["serve", "--yes", "--https=14500", "off"],
  ]);
});

test("inspectTailscaleServePort identifies private, Funnel, and unrelated handlers", () => {
  assert.deepEqual(inspectTailscaleServePort(serveConfig(443, 4500), 443), {
    configured: true,
    https: true,
    funnel: false,
    proxies: ["http://127.0.0.1:4500"],
    otherHandlers: false,
  });
  assert.equal(inspectTailscaleServePort(serveConfig(443, 4500, true), 443)?.funnel, true);
  assert.equal(inspectTailscaleServePort("{}", 443)?.configured, false);
});

test("setupTailscale refuses to overwrite an existing Serve or Funnel route", async () => {
  const calls: string[][] = [];
  const command: TailscaleCommand = async (args) => {
    calls.push(args);
    if (args[0] === "status") return result(running);
    if (args[0] === "serve" && args[1] === "status") return result(serveConfig(443, 9000, true));
    return result();
  };
  const setup = await setupTailscale({ localPort: 4500, httpsPort: 443 }, command);
  assert.equal(setup.ok, false);
  assert.match(setup.error || "", /already used/i);
  assert.equal(calls.filter((args) => args[0] === "serve").length, 1, "only the read-only status call ran");
});

test("setupTailscale reuses its exact existing listener idempotently", async () => {
  const calls: string[][] = [];
  const command: TailscaleCommand = async (args) => {
    calls.push(args);
    if (args[0] === "status") return result(running);
    if (args[0] === "serve" && args[1] === "status") return result(serveConfig(443, 4500));
    return result();
  };
  const setup = await setupTailscale({ localPort: 4500, httpsPort: 443 }, command);
  assert.equal(setup.ok, true);
  assert.equal(setup.serveOutput, "listener already configured");
  assert.equal(calls.filter((args) => args[0] === "serve").length, 1);
});

test("disableTailscaleServe refuses to remove a listener it does not own", async () => {
  const calls: string[][] = [];
  const command: TailscaleCommand = async (args) => {
    calls.push(args);
    return result(serveConfig(443, 9000));
  };
  const disabled = await disableTailscaleServe(443, 4500, command);
  assert.equal(disabled.ok, false);
  assert.match(disabled.error || "", /refusing/i);
  assert.deepEqual(calls, [["serve", "status", "--json"]]);
});

test("peer relay setup changes only relay listener preferences", async () => {
  const calls: string[][] = [];
  const command: TailscaleCommand = async (args) => {
    calls.push(args);
    return result();
  };
  const configured = await configureTailscalePeerRelay(
    40000,
    ["203.0.113.8:40000"],
    command,
  );
  assert.equal(configured.ok, true);
  assert.deepEqual(calls, [[
    "set",
    "--relay-server-port=40000",
    "--relay-server-static-endpoints=203.0.113.8:40000",
  ]]);
});

test("peer relay disable leaves all unrelated Tailscale settings alone", async () => {
  const calls: string[][] = [];
  const command: TailscaleCommand = async (args) => {
    calls.push(args);
    return result();
  };
  assert.equal((await disableTailscalePeerRelay(command)).ok, true);
  assert.deepEqual(calls, [["set", "--relay-server-port="]]);
});

test("parseTailscalePing recognizes DERP, peer relay, and direct samples", () => {
  const samples = parseTailscalePing([
    "pong from dev-b via DERP(hkg) in 80ms",
    "pong from dev-b via peer-relay(100.9.9.9:40000:vni:1) in 9ms",
    "pong from dev-b via 1.2.3.4:41641 in 4.5ms",
  ].join("\n"));
  assert.deepEqual(samples.map((sample) => sample.connection), ["derp", "peer-relay", "direct"]);
  assert.equal(samples[2].latencyMs, 4.5);
});

test("diagnoseTailscale reports the settled route and median latency", async () => {
  const command: TailscaleCommand = async (args) => {
    if (args[0] === "ping") {
      return result([
        "pong from dev-b via DERP(hkg) in 80ms",
        "pong from dev-b via peer-relay(100.9.9.9:40000:vni:1) in 8ms",
        "pong from dev-b via peer-relay(100.9.9.9:40000:vni:1) in 10ms",
      ].join("\n"));
    }
    return result(JSON.stringify({ UDP: true, PreferredDERP: 10 }));
  };
  const diagnosis = await diagnoseTailscale("dev-b", command);
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.connection, "peer-relay");
  assert.equal(diagnosis.latencyMs, 9);
  assert.equal(diagnosis.udp, true);
  assert.equal(diagnosis.nearestDerp, "10");
});
