export type Point = { x: number; y: number };
export type Box = { left: number; right: number; top: number; bottom: number };
export type DropSide = "on" | "before" | "after";

const contains = (box: Box, point: Point) => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;

/** How far a point is from a box, rows first: empty space in a row belongs to a widget in that row, however far along it. */
export function distanceToBox(box: Box, point: Point) {
  const dx = Math.max(box.left - point.x, 0, point.x - box.right), dy = Math.max(box.top - point.y, 0, point.y - box.bottom);
  return dy * 100_000 + dx;
}

/** Where a pointer sits relative to the nearest widget: on it, or in the empty space before or after it. */
export function dropSide(box: Box, point: Point): DropSide {
  if (contains(box, point)) return "on";
  return point.y > box.bottom || (point.x > box.right && point.y >= box.top) ? "after" : "before";
}

/** The order after dropping a widget: on another takes its place; beside another goes next to it. */
export function moveWidget(items: string[], active: string, over: string, side: DropSide) {
  const from = items.indexOf(active), to = items.indexOf(over);
  if (from < 0 || to < 0 || from === to) return items;
  const rest = items.filter(item => item !== active);
  const at = rest.indexOf(over);
  // On a widget means taking its slot, which lands after it when moving forward and before it when moving back.
  const index = side === "on" ? (from < to ? at + 1 : at) : side === "after" ? at + 1 : at;
  return [...rest.slice(0, index), active, ...rest.slice(index)];
}
