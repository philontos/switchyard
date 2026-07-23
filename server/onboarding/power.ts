import fs from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";

type DB = Database.Database;
const pexec = promisify(execFile);
const CAFFEINATE = "/usr/bin/caffeinate";
const PMSET = "/usr/bin/pmset";
const SYSTEM_PROFILER = "/usr/sbin/system_profiler";
const IOREG = "/usr/sbin/ioreg";

let keepAwakeChild: ChildProcess | null = null;

export type PowerSource = "ac" | "battery" | "unknown";

export interface PowerSnapshot {
  supported: boolean;
  source: PowerSource;
  model: string | null;
  laptop: boolean | null;
  idle_sleep_minutes: number | null;
  display_sleep_minutes: number | null;
  display_can_sleep: boolean | null;
  keep_awake_enabled: boolean;
  keep_awake_active: boolean;
  state: "ready" | "needs-action" | "needs-power" | "manual-check";
  lid: "not-applicable" | "clamshell-ready" | "clamshell-required" | "unknown";
  lid_closed: boolean | null;
}

export interface ParsedPmset {
  battery: Record<string, number>;
  ac: Record<string, number>;
}

/** Parse only integer pmset settings; paths and other free-form values are
 * deliberately ignored so this remains a small, stable diagnostic boundary. */
export function parsePmsetCustom(raw: string): ParsedPmset {
  const profiles: ParsedPmset = { battery: {}, ac: {} };
  let current: keyof ParsedPmset | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.trim().toLowerCase();
    if (heading === "battery power:") {
      current = "battery";
      continue;
    }
    if (heading === "ac power:") {
      current = "ac";
      continue;
    }
    const setting = line.trim().match(/^([a-z][a-z0-9]*)\s+(-?\d+)$/i);
    if (current && setting) profiles[current][setting[1]] = Number(setting[2]);
  }
  return profiles;
}

export function parsePowerSource(raw: string): PowerSource {
  if (/drawing from ['"]AC Power['"]/i.test(raw)) return "ac";
  if (/drawing from ['"]Battery Power['"]/i.test(raw)) return "battery";
  return "unknown";
}

export function parseMacHardware(raw: string): { name: string | null; model: string | null } {
  try {
    const item = JSON.parse(raw)?.SPHardwareDataType?.[0];
    return {
      name: typeof item?.machine_name === "string" ? item.machine_name : null,
      model: typeof item?.machine_model === "string" ? item.machine_model : null,
    };
  } catch {
    return { name: null, model: null };
  }
}

export function parseClamshell(raw: string): { closed: boolean | null; causesSleep: boolean | null } {
  const read = (key: string): boolean | null => {
    const match = raw.match(new RegExp(`"${key}"\\s*=\\s*(Yes|No)`, "i"));
    return match ? match[1].toLowerCase() === "yes" : null;
  };
  return {
    closed: read("AppleClamshellState"),
    causesSleep: read("AppleClamshellCausesSleep"),
  };
}

function preferenceEnabled(db: DB): boolean {
  const row = db.prepare(
    "SELECT detail FROM onboarding_events WHERE kind='power-keep-awake'",
  ).get() as { detail: string | null } | undefined;
  if (!row) return false;
  try {
    return JSON.parse(row.detail || "{}")?.enabled === true;
  } catch {
    return false;
  }
}

function startKeepAwake(): boolean {
  if (process.platform !== "darwin" || !fs.existsSync(CAFFEINATE)) return false;
  if (keepAwakeChild && keepAwakeChild.exitCode == null && !keepAwakeChild.killed) return true;
  const child = spawn(CAFFEINATE, ["-s", "-w", String(process.pid)], {
    stdio: "ignore",
  });
  keepAwakeChild = child;
  child.once("exit", () => {
    if (keepAwakeChild === child) keepAwakeChild = null;
  });
  child.once("error", () => {
    if (keepAwakeChild === child) keepAwakeChild = null;
  });
  return true;
}

function stopKeepAwake() {
  const child = keepAwakeChild;
  keepAwakeChild = null;
  if (child && child.exitCode == null) {
    try { child.kill(); } catch {}
  }
}

/** Restore the opt-in assertion after each Switchyard restart. It is scoped to
 * this server PID, requires no sudo, and disappears automatically when the
 * server exits. `-s` applies only on AC power and does not keep the display on. */
export function restoreKeepAwake(db: DB): boolean {
  return preferenceEnabled(db) ? startKeepAwake() : false;
}

export function setKeepAwake(db: DB, enabled: boolean): boolean {
  if (enabled) {
    db.prepare(
      `INSERT INTO onboarding_events (kind,detail,occurred_at)
       VALUES ('power-keep-awake',?,datetime('now'))
       ON CONFLICT(kind) DO UPDATE SET detail=excluded.detail,occurred_at=datetime('now')`,
    ).run(JSON.stringify({ enabled: true, mode: "ac-system-sleep" }));
    return startKeepAwake();
  }
  db.prepare("DELETE FROM onboarding_events WHERE kind='power-keep-awake'").run();
  stopKeepAwake();
  return false;
}

function snapshotFrom(
  input: {
    source: PowerSource;
    model: string | null;
    machineName: string | null;
    clamshellClosed: boolean | null;
    clamshellCausesSleep: boolean | null;
    settings: ParsedPmset;
    enabled: boolean;
    active: boolean;
    supported: boolean;
  },
): PowerSnapshot {
  const profile = input.source === "battery" ? input.settings.battery : input.settings.ac;
  const idleSleep = Number.isFinite(profile.sleep) ? profile.sleep : null;
  const displaySleep = Number.isFinite(profile.displaysleep) ? profile.displaysleep : null;
  const laptop = input.machineName ? /^MacBook/i.test(input.machineName) : null;
  const held = input.active && input.source === "ac";
  const globallyDisabled = idleSleep === 0;
  const state: PowerSnapshot["state"] = !input.supported
    ? "manual-check"
    : input.source === "battery" ? "needs-power"
      : (held || globallyDisabled) ? "ready" : "needs-action";
  return {
    supported: input.supported,
    source: input.source,
    model: input.machineName && input.model ? `${input.machineName} (${input.model})` : input.machineName || input.model,
    laptop,
    idle_sleep_minutes: idleSleep,
    display_sleep_minutes: displaySleep,
    display_can_sleep: displaySleep == null ? null : displaySleep > 0,
    keep_awake_enabled: input.enabled,
    keep_awake_active: input.active,
    state,
    lid: laptop === true
      ? input.clamshellCausesSleep === false ? "clamshell-ready" : "clamshell-required"
      : laptop === false ? "not-applicable" : "unknown",
    lid_closed: laptop === true ? input.clamshellClosed : null,
  };
}

export async function readPowerStatus(db: DB): Promise<PowerSnapshot> {
  const enabled = preferenceEnabled(db);
  if (enabled) startKeepAwake();
  const active = !!keepAwakeChild && keepAwakeChild.exitCode == null && !keepAwakeChild.killed;
  if (process.platform !== "darwin" || !fs.existsSync(PMSET)) {
    return snapshotFrom({
      source: "unknown",
      model: null,
      machineName: null,
      clamshellClosed: null,
      clamshellCausesSleep: null,
      settings: { battery: {}, ac: {} },
      enabled,
      active,
      supported: false,
    });
  }
  const [custom, battery, hardwareRaw, clamshellRaw] = await Promise.all([
    pexec(PMSET, ["-g", "custom"]).then((result) => result.stdout).catch(() => ""),
    pexec(PMSET, ["-g", "batt"]).then((result) => result.stdout).catch(() => ""),
    pexec(SYSTEM_PROFILER, ["SPHardwareDataType", "-json"]).then((result) => result.stdout).catch(() => ""),
    pexec(IOREG, ["-r", "-k", "AppleClamshellState", "-d", "4"]).then((result) => result.stdout).catch(() => ""),
  ]);
  const hardware = parseMacHardware(hardwareRaw);
  const clamshell = parseClamshell(clamshellRaw);
  return snapshotFrom({
    source: parsePowerSource(battery),
    model: hardware.model,
    machineName: hardware.name,
    clamshellClosed: clamshell.closed,
    clamshellCausesSleep: clamshell.causesSleep,
    settings: parsePmsetCustom(custom),
    enabled,
    active,
    supported: true,
  });
}
