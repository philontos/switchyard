import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDemoServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUTPUT = path.join(ROOT, "docs/screenshots");
const DEFAULT_CHROME = process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "/usr/bin/google-chrome";
const CHROME = process.env.CHROME_BIN || DEFAULT_CHROME;

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || "browser evaluation failed");
    }
    return result.result?.value;
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await pause(50);
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForJson(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await pause(80);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function waitFor(cdp, condition, timeoutMs = 10_000) {
  return cdp.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + ${timeoutMs};
    const tick = () => {
      try {
        if (${condition}) return resolve(true);
      } catch {}
      if (Date.now() > deadline) return reject(new Error("browser condition timed out"));
      setTimeout(tick, 50);
    };
    tick();
  })`);
}

async function metrics(cdp, width, height, scale, mobile = false) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: scale,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: mobile,
    maxTouchPoints: mobile ? 5 : 1,
  });
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 Chrome/136 Safari/537.36",
    platform: mobile ? "iPhone" : "MacIntel",
    acceptLanguage: "en-US,en",
  });
}

async function navigate(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await waitFor(cdp, `document.readyState === "complete"
    && document.getElementById("boot")?.classList.contains("done")
    && document.querySelectorAll(".task").length >= 3`);
  await pause(250);
}

async function shot(cdp, filename) {
  await pause(250);
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(path.join(OUTPUT, filename), Buffer.from(result.data, "base64"));
  console.log(`captured docs/screenshots/${filename}`);
}

async function run() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
  fs.mkdirSync(OUTPUT, { recursive: true });
  const demo = await startDemoServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-readme-"));
  const portFile = path.join(profile, "DevToolsActivePort");
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--force-color-profile=srgb",
    "--lang=en-US",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const chromeExited = new Promise((resolve) => chrome.once("exit", resolve));

  try {
    await waitForFile(portFile);
    const [debugPort] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    const pages = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`);
    const page = pages.find((candidate) => candidate.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const cdp = new Cdp(socket);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        try {
          localStorage.setItem("lang", "en");
          localStorage.setItem("theme", "dark");
          localStorage.setItem("switchyard:onboarding-seen:demo-home-studio", "1");
        } catch {}
        const freezeReadmeCapture = () => {
          if (document.getElementById("readme-capture-style")) return;
          const style = document.createElement("style");
          style.id = "readme-capture-style";
          style.textContent = \`
            *, *::before, *::after {
              animation: none !important;
              caret-color: transparent !important;
              transition: none !important;
            }
            .xterm-cursor, .xterm-cursor-block {
              visibility: hidden !important;
            }
          \`;
          document.documentElement.append(style);
        };
        if (document.documentElement) freezeReadmeCapture();
        else document.addEventListener("DOMContentLoaded", freezeReadmeCapture, { once: true });
      `,
    });

    // Main product view: parallel agents in isolated worktrees + a real live terminal.
    await metrics(cdp, 1600, 760, 2, false);
    await navigate(cdp, demo.url);
    await cdp.evaluate(`closeOnboardingModal(); connect(48); true`);
    await waitFor(cdp, `document.querySelector(".term-pane:not([style*='display: none']) .xterm-rows")?.textContent.includes("Permission required")`);
    await shot(cdp, "desktop-board.png");

    // Dispatch: one task chooses its machine-local agent and model.
    await metrics(cdp, 1600, 1000, 2, false);
    await cdp.evaluate(`
      openTaskModal(1);
      selectAgent("kimi");
      document.getElementById("t-title").value = "Audit the release candidate";
      document.getElementById("t-prompt").value = "Run the release checklist, fix regressions, and prepare a concise handoff.";
      document.getElementById("t-codex-model").value = "k3";
      true
    `);
    await waitFor(cdp, `document.getElementById("task-modal").style.display === "flex"
      && document.querySelector("#t-base .cs-trigger")?.textContent.includes("main")`);
    await shot(cdp, "dispatch-modal.png");

    // Automatic same-tailnet discovery and bilateral Switchyard connection.
    await cdp.evaluate(`cancelTaskModal(); openDiscoveryModal(); true`);
    await waitFor(cdp, `document.querySelectorAll(".discovery-peer").length === 3`);
    await shot(cdp, "device-discovery.png");

    // Evidence-backed first-run state: network, power, phone QR, and optional fleet.
    await metrics(cdp, 1600, 1000, 2, false);
    await cdp.evaluate(`closeDiscoveryModal(); openOnboardingModal(); true`);
    await waitFor(cdp, `document.querySelector(".onboarding-qr img")?.complete
      && document.querySelectorAll(".onboarding-card").length === 4`);
    await shot(cdp, "onboarding.png");

    // Mobile list: the same machines and task ownership, optimized for touch.
    await metrics(cdp, 430, 932, 3, true);
    await navigate(cdp, demo.url);
    await cdp.evaluate(`closeOnboardingModal(); true`);
    await shot(cdp, "mobile-board.png");

    // Mobile dispatch uses the same three agents and machine-local model selection.
    await cdp.evaluate(`
      openTaskModal(1);
      selectAgent("codex");
      document.getElementById("t-title").value = "Review the onboarding PR";
      document.getElementById("t-prompt").value = "Review correctness, security, and the mobile experience.";
      document.getElementById("t-codex-model").value = "gpt-5-codex";
      true
    `);
    await waitFor(cdp, `document.getElementById("task-modal").style.display === "flex"
      && document.querySelector("#t-base .cs-trigger")?.textContent.includes("main")`);
    await shot(cdp, "mobile-dispatch-codex.png");

    // Phone review: native transcript, tool folds, and a one-tap bridge to the live prompt.
    // Reload to return to a clean mobile history stack; cancelling a full-screen
    // dispatch sheet intentionally consumes its own history entry asynchronously.
    await navigate(cdp, demo.url);
    await cdp.evaluate(`closeOnboardingModal(); connect(48); true`);
    await waitFor(cdp, `document.body.classList.contains("view-terminal")
      && document.querySelectorAll("#term-read .rd-role").length >= 2
      && document.getElementById("read-banner").classList.contains("show")`);
    await shot(cdp, "mobile-reading.png");

    socket.close();
  } finally {
    if (chrome.exitCode == null) chrome.kill("SIGTERM");
    await Promise.race([chromeExited, pause(3000)]);
    await demo.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); }
    catch (error) { console.warn(`could not clean temporary Chrome profile ${profile}: ${error.message}`); }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
