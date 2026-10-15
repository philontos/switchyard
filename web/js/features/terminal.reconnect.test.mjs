import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  initTerm, openPty, disposePty, prunePanes, fitActiveNow, submitToActive,
} from "./terminal.js";

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    emit(type, event = {}) { for (const listener of listeners.get(type) || []) listener(event); },
  };
}

function element() {
  const classes = new Set();
  return {
    ...eventTarget(), style: {}, dataset: {},
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name),
    },
    appendChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    querySelector: () => null,
  };
}

let sockets, terminals, restoreGlobals;
beforeEach(t => {
  sockets = [];
  terminals = [];
  const elements = new Map();
  const globals = {
    window: eventTarget(),
    document: {
      ...eventTarget(), visibilityState: "visible", body: element(),
      createElement: element,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
    },
    navigator: { onLine: true, platform: "iPhone" },
    location: { protocol: "https:", host: "switchyard.test" },
    I18N: { lang: "en", t: key => key },
    requestAnimationFrame: fn => fn(),
    FitAddon: { FitAddon: class { fit() {} } },
    CanvasAddon: { CanvasAddon: class {} },
    Terminal: class {
      cols = 80;
      rows = 24;
      output = [];
      scrolls = 0;
      element = element();
      constructor() { terminals.push(this); }
      loadAddon() {}
      open() {}
      attachCustomKeyEventHandler() {}
      onData(listener) { this.input = listener; }
      write(data, done) { this.output.push(data); done?.(); }
      scrollToBottom() { this.scrolls++; }
      refresh() {}
      focus() {}
      dispose() { this.disposed = true; }
    },
    WebSocket: class {
      readyState = 0;
      sent = [];
      closeCalls = 0;
      constructor(url) { this.url = url; sockets.push(this); }
      open() { this.readyState = 1; this.onopen?.(); }
      message(data) { this.onmessage?.({ data }); }
      disconnect(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
      close() { this.closeCalls++; this.readyState = 2; }
      send(data) {
        assert.equal(this.readyState, 1, "only open sockets accept input");
        this.sent.push(data);
      }
    },
  };
  const originals = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  restoreGlobals = () => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  document.body.classList.add("mobile");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  initTerm();
});

afterEach(() => {
  prunePanes(new Set());
  restoreGlobals();
});

function attach(id = 1) {
  openPty(`session=task-${id}`, `Task ${id}`, "", id);
  return sockets.at(-1);
}

function visibility(state) {
  document.visibilityState = state;
  document.emit("visibilitychange");
}

test("returning from background replaces a socket still marked OPEN and shows the current screen", () => {
  const old = attach();
  old.open();
  old.message("output before background");
  const term = terminals[0];
  const lateClose = old.onclose;
  const lateMessage = old.onmessage;
  visibility("hidden");
  visibility("visible");
  assert.equal(sockets.length, 2, "resume must not trust the stale OPEN state");
  assert.equal(old.closeCalls, 1);
  assert.equal(terminals.length, 1, "retain the terminal and its existing scrollback");

  const current = sockets[1];
  current.open();
  assert.deepEqual(current.sent, ["\x00resize:80x24"], "a fresh attachment always receives its size");
  const scrolls = term.scrolls;
  current.message("current tmux screen including output generated in background");
  assert.equal(term.output.at(-1), "current tmux screen including output generated in background");
  assert.ok(term.scrolls > scrolls, "the restored screen is visible without re-entering Live");
  lateClose({ code: 1006 });
  lateMessage({ data: "obsolete socket output" });
  assert.equal(term.output.length, 2, "late events from the replaced connection cannot corrupt the screen");
});

test("pageshow and visibility resume events share one replacement connection", () => {
  const old = attach();
  old.open();
  visibility("hidden");
  window.emit("pagehide");
  visibility("visible");
  window.emit("pageshow", { persisted: true });
  document.emit("visibilitychange");
  assert.equal(sockets.length, 2);
  assert.equal(old.closeCalls, 1);
});

test("a pagehide/pageshow round trip also recovers without a visibility event", () => {
  attach().open();
  window.emit("pagehide");
  window.emit("pageshow", { persisted: true });
  assert.equal(sockets.length, 2);
});

test("a connection left CONNECTING while backgrounded is replaced on return", () => {
  const old = attach();
  visibility("hidden");
  visibility("visible");
  assert.equal(old.closeCalls, 1);
  assert.equal(sockets.length, 2);
});

test("desktop tab switching retains a healthy socket and the reading position", () => {
  document.body.classList.remove("mobile");
  const old = attach();
  old.open();
  old.message("history being read");
  const scrolls = terminals[0].scrolls;
  visibility("hidden");
  window.emit("pagehide");
  visibility("visible");
  window.emit("pageshow", { persisted: true });
  assert.equal(sockets.length, 1, "a healthy desktop attachment must not be replaced");
  assert.equal(old.closeCalls, 0);
  assert.equal(terminals[0].scrolls, scrolls, "returning must not jump to the latest output");
});

test("desktop sockets that actually close while hidden still reconnect on return", t => {
  document.body.classList.remove("mobile");
  const old = attach();
  old.open();
  visibility("hidden");
  old.disconnect();
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 1);
  visibility("visible");
  assert.equal(sockets.length, 2);
});

test("a close delivered after the foreground event retries automatically", t => {
  const old = attach();
  old.open();
  document.emit("visibilitychange");
  old.disconnect();
  assert.equal(sockets.length, 1, "retry is delayed rather than a tight reconnect loop");
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2, "no input or navigation is needed to reconnect");
  sockets[1].open();
  assert.equal(submitToActive("continue"), true);
  assert.equal(sockets[1].sent.at(-1), '\x00submit:{"text":"continue"}');
});

test("failed reconnects back off and stop retrying while the page is hidden", t => {
  attach().open();
  sockets[0].disconnect();
  t.mock.timers.tick(500);
  assert.equal(sockets.length, 2);
  sockets[1].disconnect();
  t.mock.timers.tick(500);
  assert.equal(sockets.length, 2, "second attempt waits longer");
  t.mock.timers.tick(500);
  assert.equal(sockets.length, 3);
  sockets[2].disconnect();
  visibility("hidden");
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 3);
  visibility("visible");
  assert.equal(sockets.length, 4, "foreground resumes immediately");
});

test("tmux attach failures back off even after WebSocket opens and emits an error", t => {
  let socket = attach();
  for (const delay of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
    socket.open();
    socket.message("tmux: session unavailable");
    socket.disconnect(1005);
    const attempts = sockets.length;
    t.mock.timers.tick(delay - 1);
    assert.equal(sockets.length, attempts, `retry waits ${delay} ms`);
    t.mock.timers.tick(1);
    assert.equal(sockets.length, attempts + 1);
    socket = sockets.at(-1);
  }
});

test("a sustained successful connection resets the failure backoff", t => {
  attach().open();
  sockets[0].disconnect();
  t.mock.timers.tick(500);
  sockets[1].open();
  sockets[1].disconnect();
  t.mock.timers.tick(1000);
  sockets[2].open();
  sockets[2].message("working terminal");
  t.mock.timers.tick(10000);
  sockets[2].disconnect();
  t.mock.timers.tick(499);
  assert.equal(sockets.length, 3);
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 4, "a later interruption gets the initial short retry delay");
});

test("a stalled handshake times out and retries", t => {
  const stalled = attach();
  t.mock.timers.tick(10000);
  assert.equal(stalled.closeCalls, 1);
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
});

test("network restoration replaces even an apparently open socket", t => {
  const old = attach();
  old.open();
  navigator.onLine = false;
  window.emit("offline");
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 1);
  navigator.onLine = true;
  window.emit("online");
  assert.equal(sockets.length, 2);
  assert.equal(old.closeCalls, 1);
});

test("a local terminal remains usable when the browser reports no network", () => {
  navigator.onLine = false;
  attach().open();
  assert.equal(submitToActive("local work"), true);
});

test("an explicitly rejected target does not retry indefinitely", t => {
  attach().disconnect(1008);
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 1);
});

test("inactive panes reconnect when selected without stealing the current task", t => {
  const first = attach(1);
  first.open();
  attach(2).open();
  first.disconnect();
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 2, "only the selected pane retries");
  visibility("hidden");
  visibility("visible");
  assert.equal(sockets.length, 3);
  sockets[2].open();
  attach(1).open();
  assert.equal(sockets.length, 4);
  assert.equal(submitToActive("task one"), true);
  assert.equal(sockets[3].sent.at(-1), '\x00submit:{"text":"task one"}');
  assert.deepEqual(sockets[2].sent, ["\x00resize:80x24"]);
});

test("entering Live reconnects immediately and input is not sent to the obsolete socket", () => {
  const old = attach();
  old.open();
  old.disconnect();
  fitActiveNow();
  assert.equal(sockets.length, 2);
  assert.equal(submitToActive("keep this draft"), false, "the caller retains unsent text while connecting");
  assert.deepEqual(old.sent, ["\x00resize:80x24"]);
  sockets[1].open();
  assert.equal(submitToActive("keep this draft"), true);
});

test("disposing a pane cancels reconnects and ignores queued socket callbacks", t => {
  const old = attach();
  const lateOpen = old.onopen;
  const lateMessage = old.onmessage;
  const lateClose = old.onclose;
  old.open();
  old.disconnect();
  const outputCount = terminals[0].output.length;
  disposePty(1);
  lateOpen();
  lateMessage({ data: "too late" });
  lateClose({ code: 1006 });
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 1);
  assert.equal(terminals[0].output.length, outputCount);
  assert.ok(terminals[0].disposed);
});
