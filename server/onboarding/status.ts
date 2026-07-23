import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import type Database from "better-sqlite3";
import type { Host } from "../core/db.js";
import { NS } from "../core/paths.js";
import {
  inspectTailscaleServePort,
  systemTailscaleCommand,
  tailscaleStatus,
  type TailscaleCommand,
  type TailscaleServePort,
  type TailscaleStatus,
} from "../network/tailscale.js";
import { readPowerStatus, type PowerSnapshot } from "./power.js";

type DB = Database.Database;

export const TAILSCALE_INSTALL_URL = "https://tailscale.com/download";
export const MOBILE_QR_PATH = "/api/onboarding/mobile-qr.svg";

export type OnboardingNetworkState =
  | "tailscale-missing"
  | "tailscale-login"
  | "tailscale-stopped"
  | "serve-consent"
  | "serve-setup"
  | "serve-conflict"
  | "network-error"
  | "ready";

export interface OnboardingFacts {
  instanceId: string;
  machineName: string;
  platform: NodeJS.Platform;
  localPort: number;
  httpsPort: number;
  tailscale: TailscaleStatus;
  listener: TailscaleServePort | null;
  serveError: string | null;
  magicDnsResolves: boolean | null;
  sshListening: boolean;
  power: PowerSnapshot;
  hosts: Array<Pick<Host, "ssh_ready" | "tdsp_bin" | "connection_source">>;
  mobileCheckin: { occurred_at: string; detail: string | null } | null;
}

export interface OnboardingStatus {
  schema_version: 1;
  instance_id: string;
  machine: {
    name: string;
    platform: NodeJS.Platform;
    local_url: string;
  };
  network: {
    state: OnboardingNetworkState;
    installed: boolean;
    running: boolean;
    account: string | null;
    dns_name: string | null;
    ips: string[];
    install_url: string;
    auth_url: string | null;
    magic_dns: {
      enabled: boolean;
      resolves_locally: boolean | null;
    };
    serve: {
      ready: boolean;
      state: "blocked" | "consent" | "setup" | "conflict" | "error" | "ready";
      local_port: number;
      https_port: number;
      url: string | null;
      consent_url: string | null;
      error: string | null;
    };
  };
  phone: {
    state: "blocked" | "ready-to-scan" | "verified";
    url: string | null;
    qr_path: string | null;
    verified_at: string | null;
    device: string | null;
  };
  availability: PowerSnapshot;
  fleet: {
    state: "no-peers" | "ssh-action" | "ready";
    connected: number;
    ssh_ready: number;
    ssh_pending: number;
    local_ssh: {
      listening: boolean;
      guidance: "macos-remote-login" | "linux-openssh" | "windows-openssh";
    };
  };
  ready: {
    local: true;
    always_on: boolean;
    phone: boolean;
    fleet: boolean;
  };
  recommended:
    | "install-tailscale"
    | "login-tailscale"
    | "start-tailscale"
    | "authorize-serve"
    | "configure-serve"
    | "resolve-serve-conflict"
    | "retry-network"
    | "connect-power"
    | "enable-keep-awake"
    | "scan-phone"
    | "enable-ssh"
    | "complete";
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function onboardingPorts(env: NodeJS.ProcessEnv = process.env) {
  const local = Number(env.PORT || 4500);
  const requestedHttps = Number(env.TDSP_TAILSCALE_PORT || 443);
  return {
    localPort: validPort(local) ? local : 4500,
    httpsPort: validPort(requestedHttps) ? requestedHttps : 443,
  };
}

function serveUrl(status: TailscaleStatus, httpsPort: number): string | null {
  const dnsName = status.self?.dnsName;
  if (!dnsName) return null;
  return `https://${dnsName}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
}

function phoneUrl(url: string | null): string | null {
  if (!url) return null;
  const parsed = new URL(url);
  parsed.searchParams.set("onboarding", "mobile");
  return parsed.toString();
}

function listenerMatches(listener: TailscaleServePort | null, localPort: number): boolean {
  return !!listener
    && listener.configured
    && listener.https
    && !listener.funnel
    && !listener.otherHandlers
    && listener.proxies.length === 1
    && listener.proxies[0] === `http://127.0.0.1:${localPort}`;
}

function consentUrl(status: TailscaleStatus): string | null {
  return status.self?.id
    ? `https://login.tailscale.com/f/serve?node=${encodeURIComponent(status.self.id)}`
    : null;
}

function parseMobileDevice(detail: string | null): string | null {
  try {
    const value = JSON.parse(detail || "{}");
    return typeof value?.device === "string" ? value.device : null;
  } catch {
    return null;
  }
}

function sshGuidance(platform: NodeJS.Platform): "macos-remote-login" | "linux-openssh" | "windows-openssh" {
  if (platform === "darwin") return "macos-remote-login";
  if (platform === "win32") return "windows-openssh";
  return "linux-openssh";
}

export function deriveOnboardingStatus(facts: OnboardingFacts): OnboardingStatus {
  const ts = facts.tailscale;
  const running = ts.state === "running";
  const readyListener = running && listenerMatches(facts.listener, facts.localPort);
  const url = readyListener ? serveUrl(ts, facts.httpsPort) : null;
  const needsConsent = running && ts.certDomains == null;
  const conflict = running && !!facts.listener?.configured && !readyListener;

  let networkState: OnboardingNetworkState;
  let serveState: OnboardingStatus["network"]["serve"]["state"];
  if (!ts.available) {
    networkState = "tailscale-missing";
    serveState = "blocked";
  } else if (ts.state === "needs-login") {
    networkState = "tailscale-login";
    serveState = "blocked";
  } else if (ts.state === "stopped") {
    networkState = "tailscale-stopped";
    serveState = "blocked";
  } else if (!running) {
    networkState = "network-error";
    serveState = "error";
  } else if (needsConsent) {
    networkState = "serve-consent";
    serveState = "consent";
  } else if (facts.serveError) {
    networkState = "network-error";
    serveState = "error";
  } else if (conflict) {
    networkState = "serve-conflict";
    serveState = "conflict";
  } else if (!readyListener) {
    networkState = "serve-setup";
    serveState = "setup";
  } else {
    networkState = "ready";
    serveState = "ready";
  }

  const mobileUrl = phoneUrl(url);
  const phoneState: OnboardingStatus["phone"]["state"] = !url
    ? "blocked"
    : facts.mobileCheckin ? "verified" : "ready-to-scan";
  const connected = facts.hosts.length;
  const sshReady = facts.hosts.filter((host) => host.ssh_ready === 1 && !!host.tdsp_bin).length;
  const sshPending = connected - sshReady;
  const fleetState: OnboardingStatus["fleet"]["state"] = connected === 0
    ? "no-peers"
    : (!facts.sshListening || sshPending > 0) ? "ssh-action" : "ready";

  const recommended: OnboardingStatus["recommended"] =
    networkState === "tailscale-missing" ? "install-tailscale"
      : networkState === "tailscale-login" ? "login-tailscale"
        : networkState === "tailscale-stopped" ? "start-tailscale"
          : networkState === "serve-consent" ? "authorize-serve"
            : networkState === "serve-setup" ? "configure-serve"
              : networkState === "serve-conflict" ? "resolve-serve-conflict"
                : networkState === "network-error" ? "retry-network"
                  : facts.power.supported && facts.power.state === "needs-power" ? "connect-power"
                    : facts.power.supported && facts.power.state !== "ready" ? "enable-keep-awake"
                      : phoneState !== "verified" ? "scan-phone"
                        : connected > 0 && fleetState !== "ready" ? "enable-ssh"
                          : "complete";

  return {
    schema_version: 1,
    instance_id: facts.instanceId,
    machine: {
      name: facts.machineName,
      platform: facts.platform,
      local_url: `http://127.0.0.1:${facts.localPort}`,
    },
    network: {
      state: networkState,
      installed: ts.available,
      running,
      account: ts.self?.loginName || ts.tailnet,
      dns_name: ts.self?.dnsName || null,
      ips: ts.self?.ips || [],
      install_url: TAILSCALE_INSTALL_URL,
      auth_url: ts.authUrl,
      magic_dns: {
        enabled: ts.magicDnsEnabled,
        resolves_locally: facts.magicDnsResolves,
      },
      serve: {
        ready: readyListener,
        state: serveState,
        local_port: facts.localPort,
        https_port: facts.httpsPort,
        url,
        consent_url: needsConsent ? consentUrl(ts) : null,
        error: facts.serveError || ts.error,
      },
    },
    phone: {
      state: phoneState,
      url: mobileUrl,
      qr_path: mobileUrl ? MOBILE_QR_PATH : null,
      verified_at: facts.mobileCheckin?.occurred_at || null,
      device: parseMobileDevice(facts.mobileCheckin?.detail || null),
    },
    availability: facts.power,
    fleet: {
      state: fleetState,
      connected,
      ssh_ready: sshReady,
      ssh_pending: sshPending,
      local_ssh: {
        listening: facts.sshListening,
        guidance: sshGuidance(facts.platform),
      },
    },
    ready: {
      local: true,
      always_on: facts.power.state === "ready",
      phone: phoneState === "verified",
      fleet: fleetState === "ready",
    },
    recommended,
  };
}

async function resolvesLocally(hostname: string): Promise<boolean> {
  const lookup = dns.lookup(hostname).then(() => true).catch(() => false);
  const timeout = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 1200);
    timer.unref();
  });
  return Promise.race([lookup, timeout]);
}

export function localSshListening(timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.createConnection({ host: "127.0.0.1", port: 22 });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export interface ReadOnboardingOptions {
  env?: NodeJS.ProcessEnv;
  command?: TailscaleCommand;
  platform?: NodeJS.Platform;
  hostname?: string;
  resolveDns?: (hostname: string) => Promise<boolean>;
  checkSsh?: () => Promise<boolean>;
}

export async function readOnboardingStatus(
  db: DB,
  options: ReadOnboardingOptions = {},
): Promise<OnboardingStatus> {
  const env = options.env ?? process.env;
  const { localPort, httpsPort } = onboardingPorts(env);
  const command = options.command ?? systemTailscaleCommand();
  const status = await tailscaleStatus(command);
  let listener: TailscaleServePort | null = null;
  let serveError: string | null = null;
  if (status.state === "running") {
    const current = await command(["serve", "status", "--json"], 10_000);
    const raw = current.stdout.trim();
    listener = inspectTailscaleServePort(raw || "{}", httpsPort);
    if ((!current.ok && !raw) || !listener) {
      serveError = current.stderr.trim() || "could not inspect Tailscale Serve";
    }
  }
  const dnsName = status.self?.dnsName;
  const [magicDnsResolves, sshListening, power] = await Promise.all([
    dnsName ? (options.resolveDns ?? resolvesLocally)(dnsName) : Promise.resolve(null),
    (options.checkSsh ?? localSshListening)(),
    readPowerStatus(db),
  ]);
  const hosts = db.prepare(
    "SELECT ssh_ready,tdsp_bin,connection_source FROM hosts WHERE kind!='local' ORDER BY id",
  ).all() as Array<Pick<Host, "ssh_ready" | "tdsp_bin" | "connection_source">>;
  const mobileCheckin = db.prepare(
    "SELECT detail,occurred_at FROM onboarding_events WHERE kind='mobile-checkin'",
  ).get() as { detail: string | null; occurred_at: string } | undefined;
  const derived = deriveOnboardingStatus({
    instanceId: NS,
    machineName: status.self?.hostName || options.hostname || os.hostname(),
    platform: options.platform ?? process.platform,
    localPort,
    httpsPort,
    tailscale: status,
    listener,
    serveError,
    magicDnsResolves,
    sshListening,
    power,
    hosts,
    mobileCheckin: mobileCheckin || null,
  });

  // A listener can survive a Switchyard restart. Re-hydrate only after proving
  // that this exact private HTTPS route still targets this process's loopback
  // port; an unrelated Serve/Funnel route can never enable peer endpoints.
  if (derived.network.serve.ready) {
    env.TDSP_TAILSCALE_SERVE = "1";
    env.TDSP_TAILSCALE_PORT = String(httpsPort);
    if (derived.network.serve.url) env.TDSP_TAILSCALE_URL = derived.network.serve.url;
  }
  return derived;
}

export function recordMobileCheckin(
  db: DB,
  input: { login: string; userAgent: string },
) {
  const userAgent = input.userAgent.slice(0, 500);
  const device = /iPad/i.test(userAgent) ? "iPad"
    : /iPhone/i.test(userAgent) ? "iPhone"
      : /Android/i.test(userAgent) ? "Android"
        : "Mobile browser";
  const detail = JSON.stringify({ login: input.login.slice(0, 200), device });
  db.prepare(
    `INSERT INTO onboarding_events (kind,detail,occurred_at)
     VALUES ('mobile-checkin',?,datetime('now'))
     ON CONFLICT(kind) DO UPDATE SET detail=excluded.detail,occurred_at=datetime('now')`,
  ).run(detail);
}
