import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Host } from "../core/db.js";
import { DATA_DIR, NS } from "../core/paths.js";
import type { TailscalePeer, TailscaleStatus } from "./tailscale.js";
import { ensureSshIdentity } from "./ssh-identity.js";

type DB = Database.Database;

export const SWITCHYARD_NODE_PROTOCOL = "switchyard-node";
export const SWITCHYARD_NODE_PROTOCOL_VERSION = 1;

export interface SwitchyardNodeDescriptor {
  protocol: typeof SWITCHYARD_NODE_PROTOCOL;
  protocol_version: number;
  instance_id: string;
  name: string;
  capabilities: string[];
  tailscale: {
    id: string;
    dns_name: string;
    ips: string[];
    login_name: string;
    serve_port: number;
  };
  ssh: {
    user: string;
    port: number;
    public_key: string;
    tdsp_bin: string | null;
  };
}

export interface PeerProbe {
  ok: boolean;
  port: number | null;
  descriptor: SwitchyardNodeDescriptor | null;
  error?: string;
}

export interface PeerRequestResult {
  ok: boolean;
  status: number | null;
  body: any;
  error?: string;
}

export type PeerJsonRequest = (
  peer: Pick<TailscalePeer, "dnsName" | "ips">,
  port: number,
  path: string,
  method?: "GET" | "POST",
  body?: unknown,
) => Promise<PeerRequestResult>;

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
}

function firstTailscaleIpv4(ips: string[]): string | null {
  return ips.find((ip) => /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) || null;
}

function resolveTdspBin(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string | null {
  const explicit = env.TDSP_BIN?.trim();
  if (explicit && path.isAbsolute(explicit) && fs.existsSync(explicit)) return explicit;
  const isolated = env.TASK_DISPATCHER_DATA_DIR?.trim();
  const candidates = [
    isolated && path.basename(isolated) === "data"
      ? path.join(path.dirname(isolated), "bin", "tdsp")
      : "",
    path.join(home, ".task-dispatcher", "bin", "tdsp"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export function tailscaleServePort(env: NodeJS.ProcessEnv = process.env): number | null {
  const value = Number(env.TDSP_TAILSCALE_PORT || "");
  return validPort(value) ? value : null;
}

export function discoveryPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  return [...new Set([tailscaleServePort(env), 443].filter((port): port is number => port != null))];
}

export function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function trustedServeIdentity(
  remoteAddress: string | undefined,
  headerLogin: string | undefined,
  status: TailscaleStatus,
): boolean {
  const loopback = remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1";
  return loopback && sameLogin(headerLogin, status.self?.loginName);
}

export async function localNodeDescriptor(
  status: TailscaleStatus,
  options: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    dataDir?: string;
    instanceId?: string;
    username?: string;
  } = {},
): Promise<SwitchyardNodeDescriptor> {
  const self = status.self;
  const servePort = tailscaleServePort(options.env);
  if (status.state !== "running" || !self?.id || !self.dnsName || !self.loginName || !servePort) {
    throw new Error("Switchyard is not running through Tailscale Serve");
  }
  const instanceId = options.instanceId ?? NS;
  const identity = await ensureSshIdentity(options.dataDir ?? DATA_DIR, instanceId);
  return {
    protocol: SWITCHYARD_NODE_PROTOCOL,
    protocol_version: SWITCHYARD_NODE_PROTOCOL_VERSION,
    instance_id: instanceId,
    name: self.hostName || os.hostname(),
    capabilities: ["tailscale-discovery-v1", "bidirectional-ssh-pair-v1"],
    tailscale: {
      id: self.id,
      dns_name: self.dnsName,
      ips: [...self.ips],
      login_name: self.loginName,
      serve_port: servePort,
    },
    ssh: {
      user: options.username ?? os.userInfo().username,
      port: 22,
      public_key: identity.publicKey,
      tdsp_bin: resolveTdspBin(options.env, options.home),
    },
  };
}

export function isNodeDescriptor(value: any): value is SwitchyardNodeDescriptor {
  return value?.protocol === SWITCHYARD_NODE_PROTOCOL
    && value?.protocol_version === SWITCHYARD_NODE_PROTOCOL_VERSION
    && typeof value?.instance_id === "string"
    && /^[a-z0-9]{4,64}$/.test(value.instance_id)
    && typeof value?.name === "string"
    && value.name.length > 0
    && value.name.length <= 120
    && Array.isArray(value?.capabilities)
    && typeof value?.tailscale?.id === "string"
    && typeof value?.tailscale?.dns_name === "string"
    && value.tailscale.dns_name.endsWith(".ts.net")
    && Array.isArray(value?.tailscale?.ips)
    && typeof value?.tailscale?.login_name === "string"
    && validPort(value?.tailscale?.serve_port)
    && typeof value?.ssh?.user === "string"
    && /^[A-Za-z0-9._-]{1,64}$/.test(value.ssh.user)
    && value?.ssh?.port === 22
    && typeof value?.ssh?.public_key === "string"
    && value.ssh.public_key.startsWith("ssh-ed25519 ")
    && (value.ssh.tdsp_bin == null
      || (typeof value.ssh.tdsp_bin === "string" && path.posix.isAbsolute(value.ssh.tdsp_bin)));
}

export function descriptorMatchesPeer(
  descriptor: SwitchyardNodeDescriptor,
  peer: TailscalePeer,
  localLogin: string,
): boolean {
  return descriptor.tailscale.id === peer.id
    && sameLogin(descriptor.tailscale.login_name, peer.loginName)
    && sameLogin(descriptor.tailscale.login_name, localLogin)
    && descriptor.tailscale.ips.some((ip) => peer.ips.includes(ip));
}

/** HTTPS via a peer IP with its MagicDNS name as TLS SNI, so corporate VPN DNS
 * cannot break discovery while certificate validation remains intact. */
export const requestPeerJson: PeerJsonRequest = (
  peer,
  port,
  requestPath,
  method = "GET",
  body,
) => {
  const ip = firstTailscaleIpv4(peer.ips);
  if (!ip || !peer.dnsName || !validPort(port)) {
    return Promise.resolve({ ok: false, status: null, body: null, error: "peer has no usable Tailscale address" });
  }
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PeerRequestResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = https.request({
      hostname: ip,
      port,
      servername: peer.dnsName,
      path: requestPath,
      method,
      headers: {
        host: `${peer.dnsName}:${port}`,
        accept: "application/json",
        ...(payload ? {
          "content-type": "application/json",
          "content-length": String(payload.length),
        } : {}),
      },
      timeout: 15_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          req.destroy(new Error("peer response exceeded limit"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: any = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch {
          return finish({ ok: false, status: res.statusCode ?? null, body: null, error: "peer returned invalid JSON" });
        }
        const ok = !!res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
        finish({
          ok,
          status: res.statusCode ?? null,
          body: parsed,
          error: ok ? undefined : String(parsed?.error || `peer returned HTTP ${res.statusCode}`),
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error("peer request timed out")));
    req.on("error", (error) => finish({ ok: false, status: null, body: null, error: error.message }));
    if (payload) req.write(payload);
    req.end();
  });
};

export async function probeSwitchyardPeer(
  peer: TailscalePeer,
  ports: number[] = discoveryPorts(),
  request: PeerJsonRequest = requestPeerJson,
): Promise<PeerProbe> {
  let lastError = "Switchyard was not found";
  for (const port of ports) {
    const result = await request(peer, port, "/.well-known/switchyard");
    if (!result.ok) {
      lastError = result.error || lastError;
      continue;
    }
    if (!isNodeDescriptor(result.body)) {
      lastError = "peer returned an incompatible Switchyard descriptor";
      continue;
    }
    return { ok: true, port, descriptor: result.body };
  }
  return { ok: false, port: null, descriptor: null, error: lastError };
}

function peerTarget(descriptor: SwitchyardNodeDescriptor): string {
  const ip = firstTailscaleIpv4(descriptor.tailscale.ips);
  if (!ip) throw new Error("peer has no Tailscale IPv4 address");
  return `${descriptor.ssh.user}@${ip}`;
}

function peerTargetAliases(descriptor: SwitchyardNodeDescriptor): string[] {
  const dns = descriptor.tailscale.dns_name.replace(/\.$/, "");
  const shortName = dns.split(".")[0];
  const ip = firstTailscaleIpv4(descriptor.tailscale.ips);
  return [...new Set([
    ip ? `${descriptor.ssh.user}@${ip}` : "",
    `${descriptor.ssh.user}@${dns}`,
    `${descriptor.ssh.user}@${shortName}`,
    dns,
    shortName,
  ].filter(Boolean))];
}

/** Store only transport/identity coordinates; the remote node remains the sole
 * owner of all repos, tasks, worktrees and sessions. */
export function upsertTailscaleHost(db: DB, descriptor: SwitchyardNodeDescriptor): Host {
  if (!isNodeDescriptor(descriptor)) throw new Error("invalid Switchyard node descriptor");
  const target = peerTarget(descriptor);
  // Prefer a record already carrying stable identity. Otherwise adopt the
  // addresses users commonly entered before discovery existed, so connecting
  // does not leave a duplicate manual machine in the rail.
  const identified = db.prepare(
    "SELECT * FROM hosts WHERE kind!='local' AND (node_id=? OR tailscale_id=?) ORDER BY id LIMIT 1",
  ).get(descriptor.instance_id, descriptor.tailscale.id) as Host | undefined;
  const aliases = peerTargetAliases(descriptor);
  const byTarget = identified ? undefined : db.prepare(
    `SELECT * FROM hosts WHERE kind!='local' AND target IN (${aliases.map(() => "?").join(",")}) ORDER BY id LIMIT 1`,
  ).get(...aliases) as Host | undefined;
  const existing = identified || byTarget;
  if (existing) {
    db.prepare(
      `UPDATE hosts SET
        name=?, target=?, kind='ssh', tdsp_bin=?, node_id=?, tailscale_id=?,
        tailscale_dns=?, tailscale_ip=?, tailscale_user=?, ssh_port=?,
        status='unknown', last_checked=NULL, ssh_ready=NULL,
        managed_ssh=1, connection_source='tailscale'
       WHERE id=?`,
    ).run(
      descriptor.name,
      target,
      descriptor.ssh.tdsp_bin,
      descriptor.instance_id,
      descriptor.tailscale.id,
      descriptor.tailscale.dns_name,
      firstTailscaleIpv4(descriptor.tailscale.ips),
      descriptor.tailscale.login_name,
      descriptor.ssh.port,
      existing.id,
    );
    return db.prepare("SELECT * FROM hosts WHERE id=?").get(existing.id) as Host;
  }
  const info = db.prepare(
    `INSERT INTO hosts (
      name,target,kind,tdsp_bin,node_id,tailscale_id,tailscale_dns,tailscale_ip,
      tailscale_user,ssh_port,ssh_ready,managed_ssh,connection_source,status
    ) VALUES (?,?,'ssh',?,?,?,?,?,?,?,NULL,1,'tailscale','unknown')`,
  ).run(
    descriptor.name,
    target,
    descriptor.ssh.tdsp_bin,
    descriptor.instance_id,
    descriptor.tailscale.id,
    descriptor.tailscale.dns_name,
    firstTailscaleIpv4(descriptor.tailscale.ips),
    descriptor.tailscale.login_name,
    descriptor.ssh.port,
  );
  return db.prepare("SELECT * FROM hosts WHERE id=?").get(Number(info.lastInsertRowid)) as Host;
}
