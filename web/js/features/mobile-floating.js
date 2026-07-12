// Geometry for the mobile special-key floating control. Kept DOM-free so the drag
// rules can be regression-tested independently of browser pointer-event plumbing.

export const FLOAT_SIZE = 48;
export const FLOAT_INSET = 10;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// `top` and `bottom` are local y coordinates inside the terminal column. The usable
// band deliberately excludes top chrome and the current bottom occlusion (composer,
// plus the special-key row while it is open).
export function floatingBounds({ width, top, bottom, size = FLOAT_SIZE, inset = FLOAT_INSET }) {
  const minX = inset;
  const maxX = Math.max(minX, width - size - inset);
  const minY = top + inset;
  const bottomY = bottom - size - inset;
  const cramped = bottomY < minY;
  const maxY = Math.max(minY, bottomY);
  return { minX, maxX, minY, maxY, size, cramped };
}

export function clampFloatingPosition(bounds, { x, y }) {
  return {
    x: clamp(x, bounds.minX, bounds.maxX),
    y: clamp(y, bounds.minY, bounds.maxY),
  };
}

// Persist an edge plus a relative vertical position, rather than raw pixels. The
// control then survives rotation, keyboard changes, safe areas, and composer growth.
export function positionFromPreference(bounds, preference = {}) {
  const edge = preference.edge === "right" ? "right" : "left";
  const rawRatio = Number(preference.yRatio);
  const yRatio = Number.isFinite(rawRatio) ? clamp(rawRatio, 0, 1) : 1;
  return {
    x: edge === "left" ? bounds.minX : bounds.maxX,
    y: bounds.minY + (bounds.maxY - bounds.minY) * yRatio,
  };
}

export function preferenceFromPosition(bounds, position) {
  const p = clampFloatingPosition(bounds, position);
  const span = bounds.maxY - bounds.minY;
  return {
    edge: p.x <= (bounds.minX + bounds.maxX) / 2 ? "left" : "right",
    yRatio: span > 0 ? (p.y - bounds.minY) / span : 0,
  };
}
