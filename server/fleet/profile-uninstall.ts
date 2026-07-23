import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ServeLifecycle, type ServeStatus } from "../core/serve-lifecycle.js";
import { ownedServeRoutes } from "../network/serve-ownership.js";
import { validProfileName } from "./bootstrap.js";

export interface ProfileUninstallOptions {
  purge?: boolean;
}

export interface ProfileUninstallResult {
  ok: boolean;
  profile: string;
  alreadyAbsent?: boolean;
  purged?: boolean;
  archivedAt?: string | null;
  launcherRemoved?: boolean;
  networkRoutesRemoved?: number;
  warnings?: string[];
  error?: "invalidProfile" | "running" | "networkCleanup" | "filesystem";
  message?: string;
  pid?: number | null;
}

export interface ProfileUninstallDeps {
  home: string;
  serveStatus?: (dataDir: string, instance: string) => ServeStatus;
  networkOff: (
    httpsPort: number,
    localPort: number,
  ) => Promise<{ ok: boolean; error?: string; reason?: "invalid" | "status" | "mismatch" | "command" }>;
  now?: () => Date;
  token?: () => string;
}

interface ProfilePaths {
  root: string;
  dataRoot: string;
  binPath: string;
  localBin: string;
  archiveRoot: string;
}

function runningFailure(profile: string, status: ServeStatus): ProfileUninstallResult {
  const state = status.state === "legacy" ? "running from an older launch" : status.state;
  return {
    ok: false,
    profile,
    error: "running",
    message: `profile "${profile}" is still ${state}; run \`tdsp-${profile} serve stop\` first`,
    pid: status.pid,
  };
}

function profilePaths(home: string, profile: string): ProfilePaths {
  const dispatcherRoot = path.join(home, ".task-dispatcher");
  const root = path.join(dispatcherRoot, "profiles", profile);
  return {
    root,
    dataRoot: path.join(root, "data"),
    binPath: path.join(root, "bin", "tdsp"),
    localBin: path.join(home, ".local", "bin", `tdsp-${profile}`),
    archiveRoot: path.join(dispatcherRoot, "uninstalled-profiles"),
  };
}

function instanceDirs(dataRoot: string): Array<{ instance: string; dataDir: string }> {
  const instances = new Set<string>();
  try {
    const current = fs.readFileSync(path.join(dataRoot, "controller-id"), "utf8").trim();
    if (/^[a-z0-9]+$/.test(current)) instances.add(current);
  } catch (error: any) {
    // A never-started profile may not have an instance id yet. Permission and
    // IO errors are not treated as "stopped": abort rather than skip the check.
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-z0-9]+$/.test(entry.name)) continue;
      const candidate = path.join(dataRoot, entry.name);
      if (
        fs.existsSync(path.join(candidate, "dispatcher.db")) ||
        fs.existsSync(path.join(candidate, "serve-config.json")) ||
        fs.existsSync(path.join(candidate, "serve-process")) ||
        fs.existsSync(path.join(candidate, "tailscale-serve-routes.json"))
      ) {
        instances.add(entry.name);
      }
    }
  } catch (error: any) {
    // Missing data root is valid for a partially installed profile.
    if (error?.code !== "ENOENT") throw error;
  }
  return [...instances].map((instance) => ({
    instance,
    dataDir: path.join(dataRoot, instance),
  }));
}

function matchingLauncher(localBin: string, expectedTarget: string): boolean {
  try {
    if (!fs.lstatSync(localBin).isSymbolicLink()) return false;
    const target = fs.readlinkSync(localBin);
    return path.resolve(path.dirname(localBin), target) === path.resolve(expectedTarget);
  } catch {
    return false;
  }
}

function removeLauncher(paths: ProfilePaths, warnings: string[]): boolean {
  const entry = fs.lstatSync(paths.localBin, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!matchingLauncher(paths.localBin, paths.binPath)) {
    warnings.push(`left ${paths.localBin} untouched because it is not this profile's managed symlink`);
    return false;
  }
  fs.unlinkSync(paths.localBin);
  return true;
}

function archiveName(profile: string, now: Date, token: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${profile}-${stamp}-${token}`;
}

/**
 * Remove one isolated profile without ever touching the canonical installation.
 * A live profile is refused. By default its whole directory is atomically moved
 * under ~/.task-dispatcher/uninstalled-profiles so sqlite, mirrors and worktrees
 * remain recoverable; --purge explicitly makes that final archive deletion
 * permanent.
 */
export async function uninstallProfile(
  profile: string,
  options: ProfileUninstallOptions,
  deps: ProfileUninstallDeps,
): Promise<ProfileUninstallResult> {
  if (!validProfileName(profile)) {
    return {
      ok: false,
      profile,
      error: "invalidProfile",
      message: "profile must be 1-32 lowercase letters, numbers, or hyphens",
    };
  }

  const paths = profilePaths(deps.home, profile);
  const warnings: string[] = [];
  if (!fs.existsSync(paths.root)) {
    let launcherRemoved = false;
    try {
      launcherRemoved = removeLauncher(paths, warnings);
    } catch (error: any) {
      warnings.push(`could not remove the launcher: ${String(error?.message || error)}`);
    }
    return {
      ok: true,
      profile,
      alreadyAbsent: true,
      purged: !!options.purge,
      archivedAt: null,
      launcherRemoved,
      networkRoutesRemoved: 0,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  const readStatus = deps.serveStatus ?? ((dataDir: string, instance: string) =>
    new ServeLifecycle({ dataDir, instance }).status());
  let instances: Array<{ instance: string; dataDir: string; status: ServeStatus }>;
  try {
    instances = instanceDirs(paths.dataRoot).map(({ dataDir, instance }) => ({
      dataDir,
      instance,
      status: readStatus(dataDir, instance),
    }));
  } catch (error: any) {
    return {
      ok: false,
      profile,
      error: "filesystem",
      message: `could not inspect the profile: ${String(error?.message || error)}`,
    };
  }
  const running = instances.map(({ status }) => status).find((status) => status.running);
  if (running) return runningFailure(profile, running);

  const routes = new Map<string, { httpsPort: number; localPort: number }>();
  for (const { dataDir, status } of instances) {
    for (const route of ownedServeRoutes(dataDir)) {
      routes.set(`${route.httpsPort}:${route.localPort}`, route);
    }
    const serve = status.options;
    if (!serve?.tailscale) continue;
    const localPort = serve.port ?? 4500;
    const httpsPort = serve.tailscaleHttpsPort ?? 443;
    routes.set(`${httpsPort}:${localPort}`, { httpsPort, localPort });
  }
  let networkRoutesRemoved = 0;
  for (const { httpsPort, localPort } of routes.values()) {
    const removed = await deps.networkOff(httpsPort, localPort);
    if (!removed.ok) {
      if (removed.reason === "mismatch") {
        warnings.push(
          `left Tailscale HTTPS :${httpsPort} untouched because it no longer points to this profile's local port`,
        );
        continue;
      }
      return {
        ok: false,
        profile,
        error: "networkCleanup",
        message:
          `could not safely remove this profile's Tailscale HTTPS :${httpsPort} route: ` +
          `${removed.error || "unknown error"}`,
      };
    }
    networkRoutesRemoved++;
  }

  // Network inspection can take a moment. Re-check immediately before the
  // atomic move so a profile started while cleanup was in progress is refused.
  let lateRunning: ServeStatus | undefined;
  try {
    lateRunning = instanceDirs(paths.dataRoot)
      .map(({ dataDir, instance }) => readStatus(dataDir, instance))
      .find((status) => status.running);
  } catch (error: any) {
    return {
      ok: false,
      profile,
      error: "filesystem",
      message: `could not re-check the profile: ${String(error?.message || error)}`,
    };
  }
  if (lateRunning) return runningFailure(profile, lateRunning);

  const token = (deps.token ?? (() => crypto.randomBytes(4).toString("hex")))();
  const destination = path.join(
    paths.archiveRoot,
    archiveName(profile, (deps.now ?? (() => new Date()))(), token),
  );
  let moved = false;
  try {
    fs.mkdirSync(paths.archiveRoot, { recursive: true });
    fs.renameSync(paths.root, destination);
    moved = true;
    let launcherRemoved = false;
    try {
      launcherRemoved = removeLauncher(paths, warnings);
    } catch (error: any) {
      warnings.push(`could not remove the launcher: ${String(error?.message || error)}`);
    }
    if (options.purge) fs.rmSync(destination, { recursive: true, force: true });
    return {
      ok: true,
      profile,
      alreadyAbsent: false,
      purged: !!options.purge,
      archivedAt: options.purge ? null : destination,
      launcherRemoved,
      networkRoutesRemoved,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (error: any) {
    return {
      ok: false,
      profile,
      error: "filesystem",
      message: moved
        ? `profile was archived at ${destination}, but final cleanup failed: ${String(error?.message || error)}`
        : String(error?.message || error),
      ...(moved ? { archivedAt: destination } : {}),
    };
  }
}
