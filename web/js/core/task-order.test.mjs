import test from "node:test";
import assert from "node:assert/strict";
import { orderTasks, rememberTaskOrder, repoOrderKey } from "./task-order.js";

test("repo order keys are scoped to the owning machine", () => {
  assert.equal(repoOrderKey(null, 7), "local:7");
  assert.equal(repoOrderKey(2, 7), "node:2:repo:7");
  assert.notEqual(repoOrderKey(2, 7), repoOrderKey(3, 7));
});

test("local and remote repos with the same numeric id keep independent orders", () => {
  const localKey = repoOrderKey(null, 19);
  const remoteKey = repoOrderKey(4, 19);
  const tasks = [{ id: 3 }, { id: 2 }, { id: 1 }];

  rememberTaskOrder(localKey, [1, 2, 3]);
  rememberTaskOrder(remoteKey, [2, 3, 1]);

  assert.deepEqual(orderTasks(localKey, tasks).map(({ id }) => id), [1, 2, 3]);
  assert.deepEqual(orderTasks(remoteKey, tasks).map(({ id }) => id), [2, 3, 1]);
});

test("new tasks stay above a remembered custom order", () => {
  const key = repoOrderKey(8, 23);
  rememberTaskOrder(key, [2, 1]);

  const ordered = orderTasks(key, [{ id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }]);
  assert.deepEqual(ordered.map(({ id }) => id), [4, 3, 2, 1]);
});
