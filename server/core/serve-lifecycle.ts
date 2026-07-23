import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ServeOptions {
  host?: string;
  hosts?: string[];
  hostCidr?: string;
  port?: number;
  tailscale?: boolean;
  tailscaleHttpsPort?: number;
}

type ActiveState = "starting" | "running";

interface ServeRecord {
  schema: 1;
  pid: number;
  token: string;
  processTitle: string;
  state: ActiveState;
  startedAt: string;
  readyAt: string | null;
  options: ServeOptions;
  command: string;
}

interface ServeConfig {
  schema: 1;
  savedAt: string;
  options: ServeOptions;
  command: string;
}

export interface ServeStatus {
  state: ActiveState | "legacy" | "stopped" | "stale";
  running: boolean;
  instance: string;
  dataDir: string;
  pid: number | null;
  startedAt: string | null;
  readyAt: string | null;
  options: ServeOptions | null;
  command: string | null;
  message?: string;
}

export interface ServeStopResult {
  ok: boolean;
  stopped: boolean;
  alreadyStopped: boolean;
  pid: number | null;
  error?: string;
}

interface InspectedProcess {
  alive: boolean;
  command: string;
}

interface LegacyProcess {
  pid: number;
  command: string;
}

export interface ServeLifecycleOptions {
  dataDir: string;
  instance: string;
  pid?: number;
  now?: () => Date;
  token?: () => string;
  inspectProcess?: (pid: number) => InspectedProcess;
  findLegacyProcesses?: () => LegacyProcess[];
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  setProcessTitle?: (title: string) => void;
  manageCurrentProcessSignals?: boolean;
  stopTimeoutMs?: number;
}

function normalizedOptions(options: ServeOptions): ServeOptions {
  return {
    ...(options.host ? { host: options.host } : {}),
    ...(options.hosts?.length ? { hosts: [...options.hosts] } : {}),
    ...(options.hostCidr ? { hostCidr: options.hostCidr } : {}),
    ...(options.port != null ? { port: options.port } : {}),
    ...(options.tailscale ? { tailscale: true } : {}),
    ...(options.tailscaleHttpsPort != null ? { tailscaleHttpsPort: options.tailscaleHttpsPort } : {}),
  };
}

function commandFlag(command: string, names: string[]): string | undefined {
  const group = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = command.match(
    new RegExp(`(?:^|\\s)--(?:${group})(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s]+))`),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function validPort(value: string | undefined, fallback: number): number | null {
  if (value == null || value === "") return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * Recover the stable serve options from a pre-lifecycle process command. This
 * intentionally understands only tdsp's small serve flag surface; malformed or
 * ambiguous commands return null instead of being guessed at.
 */
export function serveOptionsFromCommand(command: string): ServeOptions | null {
  if (!/(?:^|\s)serve(?:\s|$)/.test(command)) return null;
  const port = validPort(commandFlag(command, ["port"]), 4500);
  if (port == null) return null;
  const tailscale = /(?:^|\s)--tailscale(?:\s|$)/.test(command);
  const tailscaleHttpsPort = tailscale
    ? validPort(commandFlag(command, ["tailscale-port", "https-port"]), 443)
    : undefined;
  if (tailscale && tailscaleHttpsPort == null) return null;
  const hostsValue = commandFlag(command, ["hosts"]);
  const hosts = hostsValue
    ? hostsValue.split(",").map((host) => host.trim()).filter(Boolean)
    : undefined;
  return normalizedOptions({
    host: commandFlag(command, ["host"]),
    hosts,
    hostCidr: commandFlag(command, ["host-cidr", "cidr", "wireguard", "wg"]),
    port,
    tailscale,
    tailscaleHttpsPort: tailscaleHttpsPort ?? undefined,
  });
}

function shellDisplay(value: string): string {
  return /^[a-zA-Z0-9_./:@,+-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Stable argv used by restart, the Web updater, and human-readable status. */
export function serveOptionsToArgs(options: ServeOptions): string[] {
  const out = ["serve"];
  if (options.host) out.push("--host", options.host);
  if (options.hosts?.length) out.push("--hosts", options.hosts.join(","));
  if (options.hostCidr) out.push("--host-cidr", options.hostCidr);
  if (options.port != null) out.push("--port", String(options.port));
  if (options.tailscale) out.push("--tailscale");
  if (options.tailscaleHttpsPort != null) {
    out.push("--tailscale-port", String(options.tailscaleHttpsPort));
  }
  return out;
}

export function serveOptionsToCommand(options: ServeOptions): string {
  return ["tdsp", ...serveOptionsToArgs(options)].map(shellDisplay).join(" ");
}

function defaultInspectProcess(pid: number): InspectedProcess {
  try {
    process.kill(pid, 0);
  } catch (error: any) {
    if (error?.code === "ESRCH") return { alive: false, command: "" };
    if (error?.code !== "EPERM") return { alive: false, command: "" };
  }
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { alive: !!command, command };
  } catch {
    return { alive: false, command: "" };
  }
}

function isServeRecord(value: unknown): value is ServeRecord {
  const record = value as Partial<ServeRecord> | null;
  return !!record &&
    record.schema === 1 &&
    Number.isInteger(record.pid) &&
    (record.pid ?? 0) > 0 &&
    typeof record.token === "string" &&
    record.token.length >= 8 &&
    typeof record.processTitle === "string" &&
    (record.state === "starting" || record.state === "running") &&
    typeof record.startedAt === "string" &&
    (record.readyAt === null || typeof record.readyAt === "string") &&
    typeof record.options === "object" &&
    typeof record.command === "string";
}

function isServeConfig(value: unknown): value is ServeConfig {
  const config = value as Partial<ServeConfig> | null;
  return !!config &&
    config.schema === 1 &&
    typeof config.savedAt === "string" &&
    typeof config.options === "object" &&
    typeof config.command === "string";
}

function readJson(target: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}

function atomicWriteJson(target: string, value: unknown, token: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${token}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

export class ServeLease {
  private released = false;
  private handlersInstalled = false;
  private readonly onExit = () => {
    this.release();
  };
  private readonly onInterrupt = () => {
    this.release();
    process.exit(0);
  };

  constructor(
    private readonly lifecycle: ServeLifecycle,
    readonly record: ServeRecord,
    manageSignals: boolean,
  ) {
    if (manageSignals) this.installHandlers();
  }

  private installHandlers(): void {
    if (this.handlersInstalled) return;
    this.handlersInstalled = true;
    process.once("exit", this.onExit);
    process.once("SIGINT", this.onInterrupt);
    process.once("SIGTERM", this.onInterrupt);
  }

  private removeHandlers(): void {
    if (!this.handlersInstalled) return;
    this.handlersInstalled = false;
    process.off("exit", this.onExit);
    process.off("SIGINT", this.onInterrupt);
    process.off("SIGTERM", this.onInterrupt);
  }

  markReady(): void {
    if (this.released) throw new Error("serve lifecycle lease has already been released");
    this.lifecycle.markReady(this.record);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.removeHandlers();
    this.lifecycle.release(this.record.token);
  }
}

/**
 * One profile/instance owns one active process directory below its DATA_DIR.
 * The directory is claimed with an atomic rename, so two simultaneous starts
 * cannot both win. A random token is also placed in process.title; status/stop
 * must see that exact token in `ps` before treating a PID as ours. This makes a
 * stale state file harmless even if the OS has reused its PID.
 */
export class ServeLifecycle {
  private readonly dataDir: string;
  private readonly instance: string;
  private readonly activeDir: string;
  private readonly statePath: string;
  private readonly configPath: string;
  private readonly pid: number;
  private readonly now: () => Date;
  private readonly makeToken: () => string;
  private readonly inspectProcess: (pid: number) => InspectedProcess;
  private readonly findLegacyProcessesOverride?: () => LegacyProcess[];
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly setProcessTitle: (title: string) => void;
  private readonly manageSignals: boolean;
  private readonly stopTimeoutMs: number;

  constructor(options: ServeLifecycleOptions) {
    this.dataDir = options.dataDir;
    this.instance = options.instance;
    this.activeDir = path.join(this.dataDir, "serve-process");
    this.statePath = path.join(this.activeDir, "state.json");
    this.configPath = path.join(this.dataDir, "serve-config.json");
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? (() => new Date());
    this.makeToken = options.token ?? (() => crypto.randomBytes(10).toString("hex"));
    this.inspectProcess = options.inspectProcess ?? defaultInspectProcess;
    this.findLegacyProcessesOverride = options.findLegacyProcesses;
    this.signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.setProcessTitle = options.setProcessTitle ?? ((title) => {
      process.title = title;
    });
    this.manageSignals = options.manageCurrentProcessSignals ?? true;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  }

  private readRecord(): ServeRecord | null {
    const value = readJson(this.statePath);
    return isServeRecord(value) ? value : null;
  }

  private readConfig(): ServeConfig | null {
    const value = readJson(this.configPath);
    return isServeConfig(value) ? value : null;
  }

  private saveConfig(options: ServeOptions, savedAt = this.now().toISOString()): ServeConfig {
    const normalized = normalizedOptions(options);
    const config: ServeConfig = {
      schema: 1,
      savedAt,
      options: normalized,
      command: serveOptionsToCommand(normalized),
    };
    atomicWriteJson(this.configPath, config, this.makeToken());
    return config;
  }

  private ownsProcess(record: ServeRecord): boolean {
    const inspected = this.inspectProcess(record.pid);
    return inspected.alive && inspected.command.includes(record.processTitle);
  }

  /**
   * One-release migration bridge: a server started before lifecycle records
   * existed still has this instance's sqlite file open. `lsof` plus the exact
   * tdsp entrypoint/serve argv lets status and stop identify it without guessing
   * from a port. New managed launches never use this path.
   */
  private legacyProcesses(): LegacyProcess[] {
    if (this.findLegacyProcessesOverride) return this.findLegacyProcessesOverride();
    const dbPath = path.join(this.dataDir, "dispatcher.db");
    if (!fs.existsSync(dbPath)) return [];
    let stdout = "";
    try {
      const binary = fs.existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
      stdout = execFileSync(binary, ["-t", "--", dbPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error: any) {
      // lsof exits 1 when no process has the file open.
      stdout = String(error?.stdout || "");
    }
    const candidates: LegacyProcess[] = [];
    for (const value of new Set(stdout.split(/\s+/).filter(Boolean))) {
      const pid = Number(value);
      if (!Number.isInteger(pid) || pid <= 0 || pid === this.pid) continue;
      const inspected = this.inspectProcess(pid);
      if (!inspected.alive) continue;
      const command = inspected.command;
      if (!/server\/tdsp\.(?:ts|js)(?:\s|$)/.test(command)) continue;
      if (!/(?:^|\s)serve(?:\s|$)/.test(command)) continue;
      candidates.push({ pid, command });
    }
    return candidates;
  }

  private retireActiveDir(expectedToken?: string): boolean {
    const current = this.readRecord();
    if (expectedToken && current?.token !== expectedToken) return false;
    const retired = path.join(
      this.dataDir,
      `.serve-process-retired-${this.pid}-${this.makeToken()}`,
    );
    try {
      fs.renameSync(this.activeDir, retired);
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    fs.rmSync(retired, { recursive: true, force: true });
    return true;
  }

  status(): ServeStatus {
    const record = this.readRecord();
    const config = this.readConfig();
    if (!record) {
      const activeDirExists = fs.existsSync(this.activeDir);
      const legacy = activeDirExists ? [] : this.legacyProcesses();
      if (legacy.length) {
        const exact = legacy.length === 1 ? legacy[0] : null;
        const recovered = exact ? serveOptionsFromCommand(exact.command) : null;
        return {
          state: "legacy",
          running: true,
          instance: this.instance,
          dataDir: this.dataDir,
          pid: exact?.pid ?? null,
          startedAt: null,
          readyAt: null,
          options: config ? normalizedOptions(config.options) : recovered,
          command: exact?.command ?? null,
          message: exact
            ? "running from before lifecycle tracking was installed; stop it once, then start it again to make restart available"
            : `found ${legacy.length} legacy tdsp serve processes using this instance; refusing to choose between them`,
        };
      }
      return {
        state: activeDirExists ? "stale" : "stopped",
        running: false,
        instance: this.instance,
        dataDir: this.dataDir,
        pid: null,
        startedAt: null,
        readyAt: null,
        options: config ? normalizedOptions(config.options) : null,
        command: config?.command ?? null,
        ...(activeDirExists ? { message: "invalid or incomplete serve process record" } : {}),
      };
    }
    if (!this.ownsProcess(record)) {
      return {
        state: "stale",
        running: false,
        instance: this.instance,
        dataDir: this.dataDir,
        pid: record.pid,
        startedAt: record.startedAt,
        readyAt: record.readyAt,
        options: normalizedOptions(record.options),
        command: record.command,
        message: "recorded process is no longer running or its PID belongs to another process",
      };
    }
    return {
      state: record.state,
      running: true,
      instance: this.instance,
      dataDir: this.dataDir,
      pid: record.pid,
      startedAt: record.startedAt,
      readyAt: record.readyAt,
      options: normalizedOptions(record.options),
      command: record.command,
    };
  }

  claim(options: ServeOptions): ServeLease {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const normalized = normalizedOptions(options);

    for (let attempt = 0; attempt < 3; attempt++) {
      const legacy = this.legacyProcesses();
      if (legacy.length) {
        const detail = legacy.length === 1 ? `PID ${legacy[0].pid}` : `${legacy.length} matching processes`;
        throw new Error(
          `serve: this instance is already running without a lifecycle record (${detail}); run \`tdsp serve stop\` once first`,
        );
      }
      const token = this.makeToken();
      const processTitle = `tdsp-serve-${token}`;
      const startedAt = this.now().toISOString();
      const record: ServeRecord = {
        schema: 1,
        pid: this.pid,
        token,
        processTitle,
        state: "starting",
        startedAt,
        readyAt: null,
        options: normalized,
        command: serveOptionsToCommand(normalized),
      };
      const candidate = path.join(this.dataDir, `.serve-process-candidate-${this.pid}-${token}`);
      fs.mkdirSync(candidate, { mode: 0o700 });
      atomicWriteJson(path.join(candidate, "state.json"), record, token);

      try {
        this.setProcessTitle(processTitle);
        fs.renameSync(candidate, this.activeDir);
        return new ServeLease(this, record, this.manageSignals);
      } catch (error: any) {
        fs.rmSync(candidate, { recursive: true, force: true });
        if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      }

      const existing = this.readRecord();
      if (existing && this.ownsProcess(existing)) {
        throw new Error(
          `serve: this Switchyard instance is already ${existing.state} (PID ${existing.pid}; ${existing.command})`,
        );
      }
      this.retireActiveDir(existing?.token);
    }
    throw new Error("serve: could not claim this Switchyard instance; retry in a moment");
  }

  markReady(record: ServeRecord): void {
    const current = this.readRecord();
    if (!current || current.token !== record.token) {
      throw new Error("serve: lost ownership of the lifecycle record while starting");
    }
    const readyAt = this.now().toISOString();
    const running: ServeRecord = { ...current, state: "running", readyAt };
    atomicWriteJson(this.statePath, running, record.token);
    this.saveConfig(running.options, readyAt);
  }

  release(token: string): void {
    try {
      this.retireActiveDir(token);
    } catch {
      // Exit/signal cleanup must remain best-effort; a future status/start will
      // safely identify and retire a stale record.
    }
  }

  async stop(): Promise<ServeStopResult> {
    const status = this.status();
    if (status.state === "legacy") {
      const legacy = this.legacyProcesses();
      if (legacy.length !== 1 || status.pid == null || legacy[0].pid !== status.pid) {
        return {
          ok: false,
          stopped: false,
          alreadyStopped: false,
          pid: status.pid,
          error: "legacy serve process identity is ambiguous; refusing to signal it",
        };
      }
      const target = legacy[0];
      if (!this.readConfig()) {
        const recovered = serveOptionsFromCommand(target.command);
        if (recovered) this.saveConfig(recovered);
      }
      try {
        this.signalProcess(target.pid, "SIGTERM");
      } catch (error: any) {
        if (error?.code !== "ESRCH") {
          return {
            ok: false,
            stopped: false,
            alreadyStopped: false,
            pid: target.pid,
            error: String(error?.message || error),
          };
        }
      }
      const deadline = Date.now() + this.stopTimeoutMs;
      while (Date.now() < deadline) {
        if (!this.legacyProcesses().some((candidate) => candidate.pid === target.pid)) {
          return { ok: true, stopped: true, alreadyStopped: false, pid: target.pid };
        }
        await this.sleep(50);
      }
      return {
        ok: false,
        stopped: false,
        alreadyStopped: false,
        pid: target.pid,
        error: `legacy PID ${target.pid} did not stop within ${this.stopTimeoutMs}ms`,
      };
    }
    if (!status.running || status.pid == null) {
      const stale = this.readRecord();
      if (stale) this.retireActiveDir(stale.token);
      else if (fs.existsSync(this.activeDir)) this.retireActiveDir();
      return {
        ok: true,
        stopped: false,
        alreadyStopped: true,
        pid: status.pid,
      };
    }

    const record = this.readRecord();
    if (!record || record.pid !== status.pid || !this.ownsProcess(record)) {
      return {
        ok: false,
        stopped: false,
        alreadyStopped: false,
        pid: status.pid,
        error: "serve process identity changed; refusing to signal it",
      };
    }

    try {
      this.signalProcess(record.pid, "SIGTERM");
    } catch (error: any) {
      if (error?.code !== "ESRCH") {
        return {
          ok: false,
          stopped: false,
          alreadyStopped: false,
          pid: record.pid,
          error: String(error?.message || error),
        };
      }
    }

    const deadline = Date.now() + this.stopTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.ownsProcess(record)) {
        this.retireActiveDir(record.token);
        return { ok: true, stopped: true, alreadyStopped: false, pid: record.pid };
      }
      await this.sleep(50);
    }
    return {
      ok: false,
      stopped: false,
      alreadyStopped: false,
      pid: record.pid,
      error: `PID ${record.pid} did not stop within ${this.stopTimeoutMs}ms`,
    };
  }
}
