// Evidence-backed first-run flow. The server owns every system check; this
// module only renders the next useful action and never caches readiness.
import { $, api } from "../core/dom.js";
import { toast } from "../core/feedback.js";

let onboarding = null;
let onboardingBusy = false;
let phoneArrival = false;
let refreshTimer = null;

const esc = (value) => String(value ?? "").replace(
  /[&<>"']/g,
  (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
);

function isMobileBrowser() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

function seenKey() {
  return onboarding ? `switchyard:onboarding-seen:${onboarding.instance_id}` : "switchyard:onboarding-seen";
}

function statusMark(done, warning = false) {
  return `<span class="onboarding-state ${done ? "done" : warning ? "warn" : "pending"}">${
    done ? "✓" : warning ? "!" : "·"
  }</span>`;
}

function statusLabel(done, warning = false) {
  return `<span class="onboarding-pill ${done ? "done" : warning ? "warn" : ""}">${
    t(done ? "onboarding.done" : warning ? "onboarding.actionNeeded" : "onboarding.pending")
  }</span>`;
}

function card({ number, title, done, warning = false, optional = false, body, action = "" }) {
  return `<section class="onboarding-card${done ? " complete" : warning ? " warning" : ""}">
    <div class="onboarding-card-head">
      ${statusMark(done, warning)}
      <div class="onboarding-card-title"><span class="onboarding-number">${number}</span>${esc(title)}${
        optional ? `<span class="onboarding-optional">${t("onboarding.optional")}</span>` : ""
      }</div>
      ${statusLabel(done, warning)}
    </div>
    <div class="onboarding-card-body">${body}</div>
    ${action ? `<div class="onboarding-card-action">${action}</div>` : ""}
  </section>`;
}

function networkActionLabel(state) {
  if (state === "tailscale-missing") return t("onboarding.network.install");
  if (state === "tailscale-login") return t("onboarding.network.login");
  if (state === "tailscale-stopped") return t("onboarding.network.start");
  if (state === "serve-consent") return t("onboarding.network.authorize");
  if (state === "serve-setup") return t("onboarding.network.configure");
  return t("onboarding.recheck");
}

function networkCard(status) {
  const network = status.network;
  const ready = network.state === "ready";
  let body = "";
  let action = "";
  if (ready) {
    body = `<div class="onboarding-line">${t("onboarding.network.ready", {
      account: esc(network.account || ""),
    })}</div>
      <code class="onboarding-url">${esc(network.serve.url || "")}</code>`;
    if (network.magic_dns.resolves_locally === false) {
      body += `<div class="onboarding-note warn">${t("onboarding.network.dnsWarning", {
        localUrl: esc(status.machine.local_url),
      })}</div>`;
    }
  } else {
    body = `<div class="onboarding-line">${t(`onboarding.network.state.${network.state}`)}</div>`;
    if (network.serve.error) body += `<div class="onboarding-note error">${esc(network.serve.error)}</div>`;
    action = `<button class="primary" type="button" ${onboardingBusy ? "disabled" : ""}
      onclick="onboardingNetworkAction()">${onboardingBusy ? t("onboarding.working") : networkActionLabel(network.state)}</button>`;
  }
  return card({
    number: 1,
    title: t("onboarding.network.title"),
    done: ready,
    warning: network.state === "serve-conflict" || network.state === "network-error",
    body,
    action,
  });
}

function availabilityCard(status) {
  const power = status.availability;
  const done = power.state === "ready";
  let body;
  let action = "";
  if (!power.supported) {
    body = `<div class="onboarding-line">${t("onboarding.power.manual")}</div>`;
  } else if (power.state === "needs-power") {
    body = `<div class="onboarding-line">${t("onboarding.power.needsPower")}</div>`;
  } else if (done) {
    body = `<div class="onboarding-line">${power.keep_awake_active
      ? t("onboarding.power.runtimeReady")
      : t("onboarding.power.systemReady")}</div>`;
    if (power.keep_awake_enabled) {
      action = `<button class="sec" type="button" ${onboardingBusy ? "disabled" : ""}
        onclick="setOnboardingKeepAwake(false)">${t("onboarding.power.disable")}</button>`;
    }
  } else {
    body = `<div class="onboarding-line">${t("onboarding.power.needsAction", {
      minutes: power.idle_sleep_minutes == null ? "?" : power.idle_sleep_minutes,
    })}</div>`;
    action = `<button class="primary" type="button" ${onboardingBusy ? "disabled" : ""}
      onclick="setOnboardingKeepAwake(true)">${t("onboarding.power.enable")}</button>`;
  }
  if (power.display_can_sleep === true) {
    body += `<div class="onboarding-note">${t("onboarding.power.displaySleep", {
      minutes: power.display_sleep_minutes,
    })}</div>`;
  } else if (power.display_can_sleep === false) {
    body += `<div class="onboarding-note warn">${t("onboarding.power.displayNever")}</div>`;
  }
  if (power.lid === "clamshell-required") {
    body += `<div class="onboarding-note lid">${t("onboarding.power.lid")}</div>`;
  } else if (power.lid === "clamshell-ready") {
    body += `<div class="onboarding-note lid ready">${t("onboarding.power.lidReady")}</div>`;
  }
  return card({
    number: 2,
    title: t("onboarding.power.title"),
    done,
    warning: power.supported && !done,
    body,
    action,
  });
}

function phoneCard(status) {
  const phone = status.phone;
  const verified = phone.state === "verified";
  if (phone.state === "blocked") {
    return card({
      number: 3,
      title: t("onboarding.phone.title"),
      done: false,
      body: `<div class="onboarding-line">${t("onboarding.phone.blocked")}</div>`,
    });
  }
  const cleanUrl = (phone.url || "").replace(/[?&]onboarding=mobile/, "");
  const verifiedLine = verified
    ? `<div class="onboarding-phone-ok">✓ ${t("onboarding.phone.verified", {
        device: esc(phone.device || t("onboarding.phone.device")),
      })}</div>`
    : `<div class="onboarding-phone-wait"><span class="discovery-spin"></span>${t("onboarding.phone.waiting")}</div>`;
  const body = `${verifiedLine}
    <div class="onboarding-phone-grid">
      <div class="onboarding-qr"><img src="${esc(phone.qr_path)}?v=${Date.now()}" alt="${esc(t("onboarding.phone.qrAlt"))}" /></div>
      <div class="onboarding-phone-steps">
        <div><b>1</b><span>${t("onboarding.phone.stepTailscale", { account: esc(status.network.account || "") })}</span></div>
        <div><b>2</b><span>${t("onboarding.phone.stepScan")}</span></div>
        <div><b>3</b><span>${t("onboarding.phone.stepHome")}</span></div>
      </div>
    </div>
    <div class="onboarding-copy-row"><code>${esc(cleanUrl)}</code>
      <button class="sec" type="button" onclick="copyOnboardingPhoneUrl()">${t("onboarding.copy")}</button>
    </div>`;
  return card({
    number: 3,
    title: t("onboarding.phone.title"),
    done: verified,
    body,
  });
}

function sshGuidance(status) {
  const guidance = status.fleet.local_ssh.guidance;
  return t(`onboarding.fleet.${guidance}`);
}

function fleetCard(status) {
  const fleet = status.fleet;
  const done = fleet.state === "ready";
  let body;
  let action;
  if (fleet.state === "no-peers") {
    body = `<div class="onboarding-line">${t("onboarding.fleet.none")}</div>
      <div class="onboarding-note">${t("onboarding.fleet.otherSetup")}</div>`;
    action = `<button class="primary" type="button" onclick="openDiscoveryFromOnboarding()">${t("onboarding.fleet.discover")}</button>`;
  } else if (done) {
    body = `<div class="onboarding-line">${t("onboarding.fleet.ready", { count: fleet.connected })}</div>`;
    action = `<button class="sec" type="button" onclick="openDiscoveryFromOnboarding()">${t("onboarding.fleet.manage")}</button>`;
  } else {
    body = `<div class="onboarding-line">${t("onboarding.fleet.pending", {
      ready: fleet.ssh_ready,
      pending: fleet.ssh_pending,
    })}</div>`;
    if (!fleet.local_ssh.listening) {
      body += `<div class="onboarding-note warn">${sshGuidance(status)}</div>`;
    } else if (fleet.ssh_pending) {
      body += `<div class="onboarding-note warn">${t("onboarding.fleet.remotePending")}</div>`;
    }
    action = `<button class="sec" type="button" onclick="openDiscoveryFromOnboarding()">${t("onboarding.fleet.manage")}</button>`;
  }
  return card({
    number: 4,
    title: t("onboarding.fleet.title"),
    done,
    warning: fleet.state === "ssh-action",
    optional: true,
    body,
    action,
  });
}

function phoneWelcome(status) {
  return `<div class="onboarding-mobile-welcome">
    <div class="onboarding-mobile-check">✓</div>
    <h3>${t("onboarding.mobileWelcome.title")}</h3>
    <p>${t("onboarding.mobileWelcome.body", { machine: esc(status.machine.name) })}</p>
    <div class="onboarding-mobile-home">${t("onboarding.mobileWelcome.home")}</div>
  </div>`;
}

export function repaintOnboarding() {
  if (!onboarding) return;
  const dot = $("onboarding-nav-dot");
  const remoteReady = onboarding.network.state === "ready"
    && (!onboarding.availability.supported || onboarding.ready.always_on)
    && (onboarding.ready.phone || onboarding.ready.fleet);
  const error = ["serve-conflict", "network-error"].includes(onboarding.network.state);
  dot.className = `onboarding-nav-dot ${remoteReady ? "ready" : error ? "error" : "pending"}`;
  $("onboarding-btn").title = t(remoteReady ? "onboarding.navReady" : "onboarding.navPending");
  const body = $("onboarding-body");
  if (phoneArrival && onboarding.ready.phone) {
    body.innerHTML = phoneWelcome(onboarding);
    return;
  }
  body.innerHTML = `<div class="onboarding-machine">
      <span>🖥</span><div><b>${esc(onboarding.machine.name)}</b><code>${esc(onboarding.machine.local_url)}</code></div>
    </div>
    ${networkCard(onboarding)}
    ${availabilityCard(onboarding)}
    ${phoneCard(onboarding)}
    ${fleetCard(onboarding)}`;
}

export async function refreshOnboarding() {
  try {
    onboarding = await api("/api/onboarding/status");
    repaintOnboarding();
    return onboarding;
  } catch (error) {
    toast(String(error?.message || error), "error");
    return null;
  }
}

export async function onboardingNetworkAction() {
  if (!onboarding || onboardingBusy) return;
  const network = onboarding.network;
  const directUrl = network.state === "tailscale-missing" ? network.install_url
    : network.state === "serve-consent" ? network.serve.consent_url
      : network.state === "tailscale-login" ? network.auth_url : null;
  if (directUrl) {
    window.open(directUrl, "_blank", "noopener");
    return;
  }
  onboardingBusy = true;
  repaintOnboarding();
  const popup = window.open("about:blank", "_blank");
  try {
    const result = await api("/api/onboarding/network/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ https_port: network.serve.https_port }),
    });
    onboarding = result.onboarding;
    popup?.close();
    toast(t("onboarding.network.configured"), "success");
  } catch (error) {
    if (error?.body?.onboarding) onboarding = error.body.onboarding;
    const nextUrl = error?.body?.auth_url || error?.body?.consent_url;
    if (nextUrl && popup) popup.location.href = nextUrl;
    else popup?.close();
    if (!nextUrl) toast(String(error?.message || error), "error");
  } finally {
    onboardingBusy = false;
    repaintOnboarding();
  }
}

export async function setOnboardingKeepAwake(enabled) {
  if (onboardingBusy) return;
  onboardingBusy = true;
  repaintOnboarding();
  try {
    const result = await api("/api/onboarding/power/keep-awake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !!enabled }),
    });
    onboarding = result.onboarding;
    toast(t(enabled ? "onboarding.power.enabledToast" : "onboarding.power.disabledToast"), "success");
  } catch (error) {
    toast(String(error?.message || error), "error");
  } finally {
    onboardingBusy = false;
    repaintOnboarding();
  }
}

export async function copyOnboardingPhoneUrl() {
  if (!onboarding?.phone?.url) return;
  try {
    await navigator.clipboard.writeText(onboarding.phone.url);
    toast(t("onboarding.copied"), "success");
  } catch {
    toast(onboarding.phone.url, "info", 8000);
  }
}

export function openDiscoveryFromOnboarding() {
  closeOnboardingModal();
  if (typeof window.openDiscoveryModal === "function") window.openDiscoveryModal();
}

export async function openOnboardingModal() {
  $("onboarding-modal").style.display = "flex";
  await refreshOnboarding();
}

export function closeOnboardingModal() {
  $("onboarding-modal").style.display = "none";
  try { localStorage.setItem(seenKey(), "1"); } catch {}
  phoneArrival = false;
}

async function mobileCheckin() {
  try {
    await api("/api/onboarding/mobile/check-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    // Direct loopback or a non-Serve proxy cannot attest a phone. The main app
    // remains usable; desktop onboarding continues to show "waiting".
  }
}

export async function initOnboarding() {
  const params = new URLSearchParams(location.search);
  phoneArrival = params.get("onboarding") === "mobile" && isMobileBrowser();
  // Read the live state first. Besides rendering the wizard, this safely
  // re-hydrates an already-existing Tailscale Serve listener after a plain
  // `tdsp serve` restart, so the following check-in can be attested.
  await refreshOnboarding();
  if (phoneArrival) {
    await mobileCheckin();
    params.delete("onboarding");
    const query = params.toString();
    history.replaceState(null, "", location.pathname + (query ? `?${query}` : "") + location.hash);
    await refreshOnboarding();
  } else if (isMobileBrowser() && location.protocol === "https:") {
    await mobileCheckin();
    await refreshOnboarding();
  }
  if (phoneArrival) {
    $("onboarding-modal").style.display = "flex";
  } else {
    let seen = false;
    try { seen = localStorage.getItem(seenKey()) === "1"; } catch {}
    if (!seen) setTimeout(() => { $("onboarding-modal").style.display = "flex"; }, 300);
  }
  if (!refreshTimer) refreshTimer = setInterval(refreshOnboarding, 10_000);
}
