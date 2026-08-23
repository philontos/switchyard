import test from "node:test";
import assert from "node:assert/strict";
import { replaceHostList } from "./host-list-scroll.js";

function resettingList(scrollTop = 0) {
  let html = "";
  return {
    scrollTop,
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      this.scrollTop = 0; // what a real scroll container does after replacement
    },
  };
}

test("task-list scroll positions are remembered independently per host", () => {
  const list = resettingList(180);
  const positions = new Map();

  replaceHostList(list, "host two", 1, 2, positions);
  assert.equal(positions.get(1), 180);
  assert.equal(list.scrollTop, 0, "an unseen host starts at the top");

  list.scrollTop = 420;
  replaceHostList(list, "host one", 2, 1, positions);
  assert.equal(positions.get(2), 420);
  assert.equal(list.scrollTop, 180, "returning to a host restores its position");
});

test("a same-host repaint preserves the current task-list position", () => {
  const list = resettingList(260);
  const positions = new Map();

  replaceHostList(list, "updated host", 7, 7, positions);

  assert.equal(positions.get(7), 260);
  assert.equal(list.scrollTop, 260);
});
