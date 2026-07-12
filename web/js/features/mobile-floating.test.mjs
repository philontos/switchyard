import test from "node:test";
import assert from "node:assert/strict";
import {
  clampFloatingPosition,
  floatingBounds,
  positionFromPreference,
  preferenceFromPosition,
} from "./mobile-floating.js";

test("floating bounds exclude top chrome and bottom input occlusion", () => {
  assert.deepEqual(
    floatingBounds({ width: 390, top: 56, bottom: 320 }),
    { minX: 10, maxX: 332, minY: 66, maxY: 262, size: 48, cramped: false },
  );
  assert.deepEqual(
    clampFloatingPosition(
      floatingBounds({ width: 390, top: 56, bottom: 320 }),
      { x: 999, y: -20 },
    ),
    { x: 332, y: 66 },
  );
});

test("preference keeps an edge and proportional height across viewport changes", () => {
  const portrait = floatingBounds({ width: 390, top: 56, bottom: 760 });
  const preference = preferenceFromPosition(portrait, { x: 330, y: 384 });
  assert.equal(preference.edge, "right");
  assert.ok(Math.abs(preference.yRatio - 0.5) < 0.01);

  const keyboardOpen = floatingBounds({ width: 390, top: 56, bottom: 360 });
  assert.deepEqual(positionFromPreference(keyboardOpen, preference), { x: 332, y: 184 });
});

test("default placement is bottom-right and malformed preferences stay safe", () => {
  const bounds = floatingBounds({ width: 320, top: 80, bottom: 260 });
  assert.deepEqual(positionFromPreference(bounds), { x: 262, y: 202 });
  assert.deepEqual(positionFromPreference(bounds, { edge: "left", yRatio: 8 }), { x: 10, y: 202 });
});

test("bounds report when chrome and input leave no safe floating lane", () => {
  const bounds = floatingBounds({ width: 320, top: 70, bottom: 120 });
  assert.equal(bounds.cramped, true);
  assert.equal(bounds.minY, bounds.maxY);
});
