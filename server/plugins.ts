// Official-channel plugin install (P1). Skills are distributed as Claude Code
// plugins; this installs a plugin via the `claude` CLI so its bundled skills
// land where server/skills.ts scans them. Two targets:
//   - global:     the user's ~/.claude  (official marketplace already there)
//   - dispatcher: an isolated CLAUDE_CONFIG_DIR under ~/.task-dispatcher, so we
//                 never touch the user's global config.
// All of this runs ON THE CONTROLLER (not via a per-task Runner) — installs are
// a controller-side operation.
import fs from "node:fs";
import { localRunner } from "./runner.js";
import { DISPATCHER_CLAUDE_CFG } from "./paths.js";

// child processes may get a stripped PATH — resolve the claude binary.
const CLAUDE_BIN =
  [`${process.env.HOME}/.local/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude"]
    .find((p) => fs.existsSync(p)) || "claude";

const OFFICIAL_MARKETPLACE_SRC = "anthropics/claude-plugins-official";

export interface AvailablePlugin {
  pluginId: string; name: string; description: string; marketplace: string; installed: boolean;
}

/** Parse `claude plugin list --available --json` → installable plugins, marking
 *  which are already installed. Tolerant of missing sections / bad JSON. */
export function parseAvailable(jsonStr: string): AvailablePlugin[] {
  let data: any;
  try { data = JSON.parse(jsonStr) || {}; } catch { return []; }
  const installed = new Set((data.installed ?? []).map((p: any) => p.id));
  return (data.available ?? []).map((p: any) => ({
    pluginId: p.pluginId,
    name: p.name,
    description: p.description ?? "",
    marketplace: p.marketplaceName ?? "",
    installed: installed.has(p.pluginId),
  }));
}

/** The env + ordered command steps to install `pluginId` into the chosen
 *  target. Dispatcher target first registers the official marketplace in the
 *  isolated config (a fresh config has none; idempotent on an existing one). */
export function installPlan(pluginId: string, target: "global" | "dispatcher"): { env: Record<string, string>; steps: string[][] } {
  if (target === "dispatcher") {
    return {
      env: { CLAUDE_CONFIG_DIR: DISPATCHER_CLAUDE_CFG },
      steps: [
        ["plugin", "marketplace", "add", OFFICIAL_MARKETPLACE_SRC],
        ["plugin", "install", pluginId],
      ],
    };
  }
  return { env: {}, steps: [["plugin", "install", pluginId]] };
}

export async function listAvailable(): Promise<AvailablePlugin[]> {
  return parseAvailable(await localRunner.exec(CLAUDE_BIN, ["plugin", "list", "--available", "--json"]));
}

export async function installPlugin(pluginId: string, target: "global" | "dispatcher"): Promise<void> {
  const { env, steps } = installPlan(pluginId, target);
  for (const args of steps) {
    try {
      await localRunner.exec(CLAUDE_BIN, args, { env });
    } catch (e) {
      // `marketplace add` is idempotent — a fresh config needs it, an existing
      // one errors "already exists"; swallow that and continue to install.
      if (args[1] === "marketplace") continue;
      throw e;
    }
  }
}
