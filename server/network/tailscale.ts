import fs from "node:fs";
import { execFile } from "node:child_process";

export type TailscaleConnection = "direct" | "peer-relay" | "derp" | "idle" | "unknown";

export interface TailscalePeer {
  id: string;
  hostName: string;
  dnsName: string;
  os: string;
  ips: string[];
  online: boolean;
  active: boolean;
  connection: TailscaleConnection;
  endpoint: string | null;
  relay: string | null;
  peerRelay: string | null;
}

export interface TailscaleStatus {
  available: boolean;
  state: "unavailable" | "needs-login" | "stopped" | "running" | "error";
  version: string | null;
  binary: string | null;
  backendState: string | null;
  authUrl: string | null;
  tailnet: string | null;
  magicDnsSuffix: string | null;
  magicDnsEnabled: boolean;
  certDomains: string[] | null;
  health: string[];
  self: TailscalePeer | null;
  peers: TailscalePeer[];
  error: string | null;
}

export interface TailscaleSetupOptions {
  localPort: number;
  httpsPort?: number;
  expose?: boolean;
  connect?: boolean;
}

export interface TailscaleSetupResult {
  ok: boolean;
  status: TailscaleStatus;
  localPort: number;
  httpsPort: number;
  url: string | null;
  serveConsentUrl?: string;
  serveOutput?: string;
  error?: string;
}

export interface TailscaleServePort {
  configured: boolean;
  https: boolean;
  funnel: boolean;
  proxies: string[];
  otherHandlers: boolean;
}

export interface TailscalePingSample {
  connection: Exclude<TailscaleConnection, "idle" | "unknown">;
  via: string;
  latencyMs: number | null;
}

export interface TailscaleDiagnosis {
  ok: boolean;
  peer: string;
  connection: TailscaleConnection;
  via: string | null;
  latencyMs: number | null;
  samples: TailscalePingSample[];
  udp: boolean | null;
  nearestDerp: string | null;
  pingOutput: string;
  netcheckOutput: string;
  error?: string;
}

export interface TailscalePeerRelayResult {
  ok: boolean;
  enabled: boolean;
  port: number | null;
  staticEndpoints: string[];
  output: string;
  error?: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  notFound?: boolean;
}

export type TailscaleCommand = (args: string[], timeoutMs?: number) => Promise<CommandResult>;

const INSTALL_URL = "https://tailscale.com/download";

function trimDns(value: unknown): string {
  return typeof value === "string" ? value.replace(/\.$/, "") : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function peerConnection(raw: any): TailscaleConnection {
  if (typeof raw?.PeerRelay === "string" && raw.PeerRelay) return "peer-relay";
  if (typeof raw?.CurAddr === "string" && raw.CurAddr) return "direct";
  if (raw?.Active && typeof raw?.Relay === "string" && raw.Relay) return "derp";
  if (raw?.Online || raw?.LastSeen) return "idle";
  return "unknown";
}

function peerFromRaw(raw: any): TailscalePeer {
  return {
    id: String(raw?.ID || raw?.PublicKey || raw?.DNSName || raw?.HostName || ""),
    hostName: String(raw?.HostName || ""),
    dnsName: trimDns(raw?.DNSName),
    os: String(raw?.OS || ""),
    ips: stringList(raw?.TailscaleIPs),
    online: raw?.Online === true,
    active: raw?.Active === true,
    connection: peerConnection(raw),
    endpoint: typeof raw?.CurAddr === "string" && raw.CurAddr ? raw.CurAddr : null,
    relay: typeof raw?.Relay === "string" && raw.Relay ? raw.Relay : null,
    peerRelay: typeof raw?.PeerRelay === "string" && raw.PeerRelay ? raw.PeerRelay : null,
  };
}

/** Parse the intentionally unstable `tailscale status --json` at one boundary. */
export function parseTailscaleStatus(raw: string, binary = "tailscale"): TailscaleStatus {
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    return {
      available: true,
      state: "error",
      version: null,
      binary,
      backendState: null,
      authUrl: null,
      tailnet: null,
      magicDnsSuffix: null,
      magicDnsEnabled: false,
      certDomains: null,
      health: [],
      self: null,
      peers: [],
      error: "tailscale status returned invalid JSON",
    };
  }

  const backendState = typeof doc?.BackendState === "string" ? doc.BackendState : "";
  const normalized = backendState.toLowerCase();
  const state: TailscaleStatus["state"] =
    normalized === "running" ? "running"
      : normalized === "needslogin" || normalized === "needsmachineauth" || normalized === "needs-machine-auth" ? "needs-login"
        : normalized === "stopped" || normalized === "starting" ? "stopped"
          : "error";
  const peerValues = doc?.Peer && typeof doc.Peer === "object" ? Object.values(doc.Peer) : [];
  const peers = peerValues
    .map(peerFromRaw)
    .filter((peer) => peer.id || peer.hostName || peer.dnsName)
    .sort((a, b) => a.hostName.localeCompare(b.hostName));
  const currentTailnet = doc?.CurrentTailnet && typeof doc.CurrentTailnet === "object" ? doc.CurrentTailnet : {};

  return {
    available: true,
    state,
    version: typeof doc?.Version === "string" ? doc.Version : null,
    binary,
    backendState: backendState || null,
    authUrl: typeof doc?.AuthURL === "string" && doc.AuthURL ? doc.AuthURL : null,
    tailnet: typeof currentTailnet?.Name === "string" ? currentTailnet.Name : null,
    magicDnsSuffix:
      typeof currentTailnet?.MagicDNSSuffix === "string"
        ? currentTailnet.MagicDNSSuffix
        : typeof doc?.MagicDNSSuffix === "string" ? doc.MagicDNSSuffix : null,
    magicDnsEnabled: currentTailnet?.MagicDNSEnabled === true,
    certDomains: Array.isArray(doc?.CertDomains) ? stringList(doc.CertDomains) : null,
    health: stringList(doc?.Health),
    self: doc?.Self ? peerFromRaw(doc.Self) : null,
    peers,
    error: state === "error" ? `unexpected Tailscale backend state: ${backendState || "unknown"}` : null,
  };
}

function unavailableStatus(error: string): TailscaleStatus {
  return {
    available: false,
    state: "unavailable",
    version: null,
    binary: null,
    backendState: null,
    authUrl: null,
    tailnet: null,
    magicDnsSuffix: null,
    magicDnsEnabled: false,
    certDomains: null,
    health: [],
    self: null,
    peers: [],
    error,
  };
}

export function resolveTailscaleBinary(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = fs.existsSync,
): string {
  if (env.TAILSCALE_BIN?.trim()) return env.TAILSCALE_BIN.trim();
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Tailscale\\tailscale.exe",
        "C:\\Program Files (x86)\\Tailscale IPN\\tailscale.exe",
      ]
    : [
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      ];
  return candidates.find(exists) || (process.platform === "win32" ? "tailscale.exe" : "tailscale");
}

export function systemTailscaleCommand(binary = resolveTailscaleBinary()): TailscaleCommand {
  return (args, timeoutMs = 15_000) =>
    new Promise((resolve) => {
      execFile(binary, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error: any, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          code: typeof error?.code === "number" ? error.code : error ? null : 0,
          notFound: error?.code === "ENOENT",
        });
      });
    });
}

export async function tailscaleStatus(
  command: TailscaleCommand = systemTailscaleCommand(),
  binary = resolveTailscaleBinary(),
): Promise<TailscaleStatus> {
  const result = await command(["status", "--json"], 10_000);
  if (result.notFound) {
    return unavailableStatus(`Tailscale is not installed. Install it from ${INSTALL_URL}`);
  }
  const raw = result.stdout.trim() || result.stderr.trim();
  if (!raw) {
    return {
      ...unavailableStatus(result.stderr.trim() || "could not talk to the Tailscale service"),
      available: true,
      state: "error",
      binary,
    };
  }
  const parsed = parseTailscaleStatus(raw, binary);
  if (!result.ok && parsed.state === "error") {
    parsed.error = result.stderr.trim() || parsed.error || "tailscale status failed";
  }
  return parsed;
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function tailscaleUrl(status: TailscaleStatus, httpsPort: number): string | null {
  const dns = status.self?.dnsName;
  if (!dns) return null;
  return `https://${dns}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
}

/** Project one node-level listener out of `tailscale serve status --json`.
 * Tailscale Services use separate virtual IPs and intentionally don't conflict
 * with this node listener, so the nested `Services` map is ignored. */
export function inspectTailscaleServePort(raw: string, port: number): TailscaleServePort | null {
  let doc: any;
  try {
    doc = JSON.parse(raw || "{}");
  } catch {
    return null;
  }
  const suffix = `:${port}`;
  const tcp = doc?.TCP?.[String(port)];
  const webEntries = doc?.Web && typeof doc.Web === "object"
    ? Object.entries(doc.Web).filter(([hostPort]) => hostPort.endsWith(suffix))
    : [];
  const funnelEntries = doc?.AllowFunnel && typeof doc.AllowFunnel === "object"
    ? Object.entries(doc.AllowFunnel).filter(([hostPort, enabled]) => hostPort.endsWith(suffix) && enabled === true)
    : [];
  const proxies: string[] = [];
  let otherHandlers = false;
  for (const [, webConfig] of webEntries as Array<[string, any]>) {
    const handlers = webConfig?.Handlers && typeof webConfig.Handlers === "object"
      ? Object.entries(webConfig.Handlers)
      : [];
    for (const [mount, handler] of handlers as Array<[string, any]>) {
      if (mount === "/" && typeof handler?.Proxy === "string") proxies.push(handler.Proxy);
      else otherHandlers = true;
    }
  }
  return {
    configured: !!tcp || webEntries.length > 0 || funnelEntries.length > 0,
    https: tcp?.HTTPS === true,
    funnel: funnelEntries.length > 0,
    proxies,
    otherHandlers,
  };
}

async function servePortStatus(
  port: number,
  command: TailscaleCommand,
): Promise<{ ok: true; listener: TailscaleServePort } | { ok: false; error: string }> {
  const current = await command(["serve", "status", "--json"], 10_000);
  const raw = current.stdout.trim();
  // An old client can fail before it knows `serve status`; don't mutate a
  // configuration we couldn't inspect.
  if (!current.ok && !raw) {
    return { ok: false, error: current.stderr.trim() || "could not inspect existing Tailscale Serve routes" };
  }
  const listener = inspectTailscaleServePort(raw || "{}", port);
  return listener
    ? { ok: true, listener }
    : { ok: false, error: "tailscale serve status returned invalid JSON" };
}

function listenerMatches(listener: TailscaleServePort, target: string): boolean {
  return listener.configured
    && listener.https
    && !listener.funnel
    && !listener.otherHandlers
    && listener.proxies.length === 1
    && listener.proxies[0] === target;
}

/**
 * Join the existing tailnet if necessary, then publish a loopback-only
 * Switchyard through Tailscale Serve. It never enables Funnel or binds the app
 * to a LAN/Tailscale interface.
 */
export async function setupTailscale(
  options: TailscaleSetupOptions,
  command: TailscaleCommand = systemTailscaleCommand(),
  binary = resolveTailscaleBinary(),
): Promise<TailscaleSetupResult> {
  const localPort = options.localPort;
  const httpsPort = options.httpsPort ?? 443;
  if (!validPort(localPort) || !validPort(httpsPort)) {
    const status = await tailscaleStatus(command, binary);
    return { ok: false, status, localPort, httpsPort, url: null, error: "ports must be integers between 1 and 65535" };
  }

  let status = await tailscaleStatus(command, binary);
  if (!status.available) {
    return { ok: false, status, localPort, httpsPort, url: null, error: status.error || "Tailscale is not installed" };
  }

  if (status.state !== "running" && options.connect !== false) {
    const up = await command(["up"], 5 * 60_000);
    status = await tailscaleStatus(command, binary);
    if (status.state !== "running") {
      const detail = [up.stderr, up.stdout, status.authUrl].filter(Boolean).join("\n").trim();
      return {
        ok: false,
        status,
        localPort,
        httpsPort,
        url: null,
        error: detail || "Tailscale needs you to finish signing in",
      };
    }
  }

  if (status.state !== "running") {
    return {
      ok: false,
      status,
      localPort,
      httpsPort,
      url: null,
      error: status.authUrl || status.error || "Tailscale is not connected",
    };
  }

  if (options.expose === false) {
    return { ok: true, status, localPort, httpsPort, url: tailscaleUrl(status, httpsPort) };
  }

  // Current Tailscale clients expose null CertDomains until a tailnet owner
  // enables HTTPS. Return the one-time consent URL immediately instead of
  // launching `tailscale serve` and waiting for that browser action.
  if (status.certDomains == null) {
    const nodeId = status.self?.id;
    const serveConsentUrl = nodeId
      ? `https://login.tailscale.com/f/serve?node=${encodeURIComponent(nodeId)}`
      : undefined;
    return {
      ok: false,
      status,
      localPort,
      httpsPort,
      url: null,
      serveConsentUrl,
      error:
        "Tailscale Serve HTTPS is not enabled for this tailnet" +
        (serveConsentUrl ? `; enable it at ${serveConsentUrl}` : ""),
    };
  }

  const target = `http://127.0.0.1:${localPort}`;
  const existing = await servePortStatus(httpsPort, command);
  if (!existing.ok) {
    return { ok: false, status, localPort, httpsPort, url: tailscaleUrl(status, httpsPort), error: existing.error };
  }
  if (existing.listener.configured) {
    if (listenerMatches(existing.listener, target)) {
      return {
        ok: true,
        status,
        localPort,
        httpsPort,
        url: tailscaleUrl(status, httpsPort),
        serveOutput: "listener already configured",
      };
    }
    return {
      ok: false,
      status,
      localPort,
      httpsPort,
      url: tailscaleUrl(status, httpsPort),
      error:
        `Tailscale HTTPS :${httpsPort} is already used by another Serve/Funnel route; ` +
        "choose another --tailscale-port instead of overwriting it",
    };
  }

  // A dedicated HTTPS port changes only that listener and doesn't reset or
  // overwrite unrelated Serve routes the user may already have.
  const serve = await command(
    ["serve", "--bg", "--yes", `--https=${httpsPort}`, target],
    60_000,
  );
  const serveOutput = [serve.stdout, serve.stderr].filter(Boolean).join("\n").trim();
  if (!serve.ok) {
    return {
      ok: false,
      status,
      localPort,
      httpsPort,
      url: tailscaleUrl(status, httpsPort),
      serveOutput,
      error: serveOutput || "tailscale serve failed",
    };
  }

  // Refresh after Serve consent/configuration; DNS name or health can change.
  status = await tailscaleStatus(command, binary);
  return {
    ok: true,
    status,
    localPort,
    httpsPort,
    url: tailscaleUrl(status, httpsPort),
    serveOutput,
  };
}

export async function disableTailscaleServe(
  httpsPort = 443,
  expectedLocalPort = 4500,
  command: TailscaleCommand = systemTailscaleCommand(),
): Promise<{ ok: boolean; error?: string }> {
  if (!validPort(httpsPort) || !validPort(expectedLocalPort)) {
    return { ok: false, error: "ports must be integers between 1 and 65535" };
  }
  const existing = await servePortStatus(httpsPort, command);
  if (!existing.ok) return existing;
  if (!existing.listener.configured) return { ok: true };
  const target = `http://127.0.0.1:${expectedLocalPort}`;
  if (!listenerMatches(existing.listener, target)) {
    return {
      ok: false,
      error:
        `Tailscale HTTPS :${httpsPort} does not point exclusively to ${target}; ` +
        "refusing to remove somebody else's Serve/Funnel route",
    };
  }
  const result = await command(["serve", "--yes", `--https=${httpsPort}`, "off"], 30_000);
  if (result.ok) return { ok: true };
  return { ok: false, error: [result.stderr, result.stdout].filter(Boolean).join("\n").trim() || "tailscale serve off failed" };
}

/**
 * Configure only the local peer-relay listener. The tailnet grant is
 * intentionally not edited here: that is an admin policy decision and needs a
 * narrowly scoped src/dst rule in the Tailscale control plane.
 */
export async function configureTailscalePeerRelay(
  port: number,
  staticEndpoints: string[] = [],
  command: TailscaleCommand = systemTailscaleCommand(),
): Promise<TailscalePeerRelayResult> {
  if (!validPort(port)) {
    return { ok: false, enabled: false, port: null, staticEndpoints, output: "", error: "port must be an integer between 1 and 65535" };
  }
  const endpoints = staticEndpoints.map((value) => value.trim()).filter(Boolean);
  const args = ["set", `--relay-server-port=${port}`];
  if (endpoints.length) args.push(`--relay-server-static-endpoints=${endpoints.join(",")}`);
  const result = await command(args, 30_000);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return result.ok
    ? { ok: true, enabled: true, port, staticEndpoints: endpoints, output }
    : { ok: false, enabled: false, port, staticEndpoints: endpoints, output, error: output || "could not enable the Tailscale peer relay" };
}

export async function disableTailscalePeerRelay(
  command: TailscaleCommand = systemTailscaleCommand(),
): Promise<TailscalePeerRelayResult> {
  const result = await command(["set", "--relay-server-port="], 30_000);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return result.ok
    ? { ok: true, enabled: false, port: null, staticEndpoints: [], output }
    : { ok: false, enabled: true, port: null, staticEndpoints: [], output, error: output || "could not disable the Tailscale peer relay" };
}

function durationMs(value: string, unit: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (unit === "s") return n * 1000;
  if (unit === "µs" || unit === "us") return n / 1000;
  return n;
}

/** Parse the stable human phrases emitted by `tailscale ping`. */
export function parseTailscalePing(output: string): TailscalePingSample[] {
  const samples: TailscalePingSample[] = [];
  for (const line of output.split(/\r?\n/)) {
    const timing = line.match(/\bin\s+([\d.]+)(ms|s|µs|us)\b/);
    const latencyMs = timing ? durationMs(timing[1], timing[2]) : null;
    const peerRelay = line.match(/\bvia peer-relay\(([^)]+)\)/i);
    if (peerRelay) {
      samples.push({ connection: "peer-relay", via: peerRelay[1], latencyMs });
      continue;
    }
    const derp = line.match(/\bvia DERP\(([^)]+)\)/i);
    if (derp) {
      samples.push({ connection: "derp", via: derp[1], latencyMs });
      continue;
    }
    const direct = line.match(/\bvia ([^\s]+) in\b/i);
    if (direct) samples.push({ connection: "direct", via: direct[1], latencyMs });
  }
  return samples;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function parseNetcheck(raw: string): { udp: boolean | null; nearestDerp: string | null } {
  try {
    const doc = JSON.parse(raw);
    return {
      udp: typeof doc?.UDP === "boolean" ? doc.UDP : null,
      nearestDerp:
        typeof doc?.PreferredDERP === "number" && doc.PreferredDERP
          ? String(doc.PreferredDERP)
          : typeof doc?.NearestDERP === "string" ? doc.NearestDERP : null,
    };
  } catch {
    const udp = raw.match(/\*\s*UDP:\s*(true|false)/i);
    const derp = raw.match(/\*\s*Nearest DERP:\s*(.+)$/im);
    return {
      udp: udp ? udp[1].toLowerCase() === "true" : null,
      nearestDerp: derp?.[1]?.trim() || null,
    };
  }
}

export async function diagnoseTailscale(
  peer: string,
  command: TailscaleCommand = systemTailscaleCommand(),
): Promise<TailscaleDiagnosis> {
  const target = peer.trim();
  if (!target) {
    return {
      ok: false,
      peer,
      connection: "unknown",
      via: null,
      latencyMs: null,
      samples: [],
      udp: null,
      nearestDerp: null,
      pingOutput: "",
      netcheckOutput: "",
      error: "peer is required",
    };
  }

  const [ping, netcheck] = await Promise.all([
    command(["ping", "--c=5", "--timeout=5s", "--until-direct=false", target], 35_000),
    command(["netcheck", "--format=json"], 20_000),
  ]);
  const pingOutput = [ping.stdout, ping.stderr].filter(Boolean).join("\n").trim();
  const netcheckOutput = [netcheck.stdout, netcheck.stderr].filter(Boolean).join("\n").trim();
  const samples = parseTailscalePing(pingOutput);
  // The last sample is the settled route after Tailscale's initial DERP packet.
  const settled = samples.at(-1);
  const matchingLatencies = samples
    .filter((sample) => sample.connection === settled?.connection && sample.latencyMs != null)
    .map((sample) => sample.latencyMs as number);
  const network = parseNetcheck(netcheck.stdout || netcheck.stderr);

  return {
    ok: ping.ok && samples.length > 0,
    peer: target,
    connection: settled?.connection || "unknown",
    via: settled?.via || null,
    latencyMs: median(matchingLatencies),
    samples,
    udp: network.udp,
    nearestDerp: network.nearestDerp,
    pingOutput,
    netcheckOutput,
    ...(!ping.ok || !samples.length
      ? { error: pingOutput || "tailscale ping failed" }
      : {}),
  };
}
