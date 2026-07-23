import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA_DIR, NS } from "../core/paths.js";

const pexec = promisify(execFile);
const KEY_COMMENT_PREFIX = "switchyard-node:";

export interface SshIdentity {
  privateKeyPath: string;
  publicKeyPath: string;
  publicKey: string;
}

export interface AuthorizedKeyResult {
  path: string;
  changed: boolean;
}

export function sshIdentityPaths(dataDir = DATA_DIR) {
  const dir = path.join(dataDir, "network", "ssh");
  return {
    dir,
    privateKeyPath: path.join(dir, "id_ed25519"),
    publicKeyPath: path.join(dir, "id_ed25519.pub"),
  };
}

function resolveSshKeygen(): string {
  return ["/usr/bin/ssh-keygen", "/opt/homebrew/bin/ssh-keygen", "/usr/local/bin/ssh-keygen"]
    .find((candidate) => fs.existsSync(candidate)) || "ssh-keygen";
}

/** Strip an untrusted comment and retain one valid OpenSSH Ed25519 key line. */
export function normalizeSshPublicKey(value: string, instanceId: string): string {
  if (!/^[a-z0-9]{4,64}$/.test(instanceId)) throw new Error("invalid Switchyard instance id");
  const fields = String(value || "").trim().split(/\s+/);
  if (fields.length < 2 || fields[0] !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+={0,2}$/.test(fields[1])) {
    throw new Error("invalid Switchyard SSH public key");
  }
  const decoded = Buffer.from(fields[1], "base64");
  if (decoded.length < 32) throw new Error("invalid Switchyard SSH public key");
  return `${fields[0]} ${fields[1]} ${KEY_COMMENT_PREFIX}${instanceId}`;
}

/** One dedicated client key per Switchyard instance/profile. */
export async function ensureSshIdentity(
  dataDir = DATA_DIR,
  instanceId = NS,
): Promise<SshIdentity> {
  const paths = sshIdentityPaths(dataDir);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(paths.dir, 0o700); } catch {}

  if (!fs.existsSync(paths.privateKeyPath)) {
    await pexec(resolveSshKeygen(), [
      "-q", "-t", "ed25519", "-N", "", "-C", `${KEY_COMMENT_PREFIX}${instanceId}`,
      "-f", paths.privateKeyPath,
    ]);
  }
  try { fs.chmodSync(paths.privateKeyPath, 0o600); } catch {}

  if (!fs.existsSync(paths.publicKeyPath)) {
    const { stdout } = await pexec(resolveSshKeygen(), ["-y", "-f", paths.privateKeyPath]);
    fs.writeFileSync(
      paths.publicKeyPath,
      normalizeSshPublicKey(stdout, instanceId) + "\n",
      { mode: 0o644 },
    );
  }
  const publicKey = normalizeSshPublicKey(fs.readFileSync(paths.publicKeyPath, "utf8"), instanceId);
  return { privateKeyPath: paths.privateKeyPath, publicKeyPath: paths.publicKeyPath, publicKey };
}

function authorizedKeysPath(home = os.homedir()): string {
  return path.join(home, ".ssh", "authorized_keys");
}

function writeAuthorizedKeys(file: string, lines: string[]) {
  const next = lines.filter(Boolean).join("\n") + (lines.some(Boolean) ? "\n" : "");
  const tmp = `${file}.switchyard-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, next, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

/**
 * Grant one peer access without touching any unrelated user key. Repeating the
 * handshake replaces the line carrying that stable instance marker.
 */
export function authorizeSwitchyardKey(
  publicKey: string,
  instanceId: string,
  home = os.homedir(),
): AuthorizedKeyResult {
  const normalized = normalizeSshPublicKey(publicKey, instanceId);
  const sshDir = path.join(home, ".ssh");
  const file = authorizedKeysPath(home);
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(sshDir, 0o700); } catch {}
  const marker = `${KEY_COMMENT_PREFIX}${instanceId}`;
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const kept = before.split(/\r?\n/).filter((line) => line.trim() && !line.trim().endsWith(marker));
  const next = [...kept, normalized];
  const rendered = next.join("\n") + "\n";
  if (rendered === before) return { path: file, changed: false };
  writeAuthorizedKeys(file, next);
  return { path: file, changed: true };
}

/** Revoke only the managed key line for one removed peer. */
export function removeSwitchyardKey(instanceId: string, home = os.homedir()): AuthorizedKeyResult {
  if (!/^[a-z0-9]{4,64}$/.test(instanceId)) throw new Error("invalid Switchyard instance id");
  const file = authorizedKeysPath(home);
  if (!fs.existsSync(file)) return { path: file, changed: false };
  const before = fs.readFileSync(file, "utf8");
  const marker = `${KEY_COMMENT_PREFIX}${instanceId}`;
  const kept = before.split(/\r?\n/).filter((line) => line.trim() && !line.trim().endsWith(marker));
  const rendered = kept.join("\n") + (kept.length ? "\n" : "");
  if (rendered === before) return { path: file, changed: false };
  writeAuthorizedKeys(file, kept);
  return { path: file, changed: true };
}
