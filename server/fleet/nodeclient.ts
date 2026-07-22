import fs from "node:fs";
import { spawn } from "node:child_process";
import type { Host } from "../core/db.js";
import { SSH_BASE_ARGS } from "./runner.js";

function resolveSsh(): string {
  return ["/usr/bin/ssh", "/opt/homebrew/bin/ssh"].find((candidate) => fs.existsSync(candidate)) || "ssh";
}

export const SSH_BIN = resolveSsh();

export interface NodeCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface NodeCommandOptions {
  input?: Buffer;
  timeoutMs?: number;
  maxBuffer?: number;
}

export type NodeCommandHost = Pick<Host, "kind" | "target" | "tdsp_bin">;

/** POSIX single-quote for the remote shell (ssh joins argv into one command). */
export function quoteNodeArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Thin SSH transport for the node-local tdsp protocol. It never executes git,
 * tmux or filesystem business operations itself; every requested verb is
 * interpreted by the target node's Switchyard installation.
 */
export function runNodeCommand(host: NodeCommandHost, args: string[], options: NodeCommandOptions = {}): Promise<NodeCommandResult> {
  if (host.kind === "local") {
    return Promise.resolve({ ok: false, stdout: "", stderr: "local host is not a remote node", code: null });
  }
  if (!host.tdsp_bin) {
    return Promise.resolve({ ok: false, stdout: "", stderr: "node does not have Switchyard installed", code: null });
  }

  const remote = [host.tdsp_bin, ...args].map(quoteNodeArg).join(" ");
  const timeoutMs = options.timeoutMs ?? 120000;
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn(SSH_BIN, [...SSH_BASE_ARGS, host.target, remote], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;

    const finish = (result: NodeCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const overflow = () => {
      try { child.kill(); } catch {}
      finish({ ok: false, stdout: Buffer.concat(stdout).toString(), stderr: "node response exceeded limit", code: null });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > maxBuffer) return overflow();
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > maxBuffer) return overflow();
      stderr.push(chunk);
    });
    child.on("error", (error) => finish({ ok: false, stdout: "", stderr: String(error.message || error), code: null }));
    child.on("close", (code) => finish({
      ok: code === 0,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
      code,
    }));

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, stdout: Buffer.concat(stdout).toString(), stderr: "node command timed out", code: null });
    }, timeoutMs);
    timer.unref();
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

export function parseNodeJson(stdout: string): any | null {
  const line = stdout.trim().split("\n").pop() || "";
  try { return JSON.parse(line); } catch { return null; }
}
