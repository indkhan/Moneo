export type Point = { x: number; y: number };
export type Box = { left: number; right: number; top: number; bottom: number };
export type DropSide = "on" | "before" | "after";

const contains = (box: Box, point: Point) => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;

export function distanceToBox(box: Box, point: Point) {
  const dx = Math.max(box.left - point.x, 0, point.x - box.right), dy = Math.max(box.top - point.y, 0, point.y - box.bottom);
  return dy * 100_000 + dx;
}

export function dropSide(box: Box, point: Point): DropSide {
  if (contains(box, point)) return "on";
  return point.y > box.bottom || (point.x > box.right && point.y >= box.top) ? "after" : "before";
}

export function moveWidget(items: string[], active: string, over: string, side: DropSide) {
  const from = items.indexOf(active), to = items.indexOf(over);
  if (from < 0 || to < 0 || from === to) return items;
  const rest = items.filter(item => item !== active);
  const at = rest.indexOf(over);
  const index = side === "on" ? (from < to ? at + 1 : at) : side === "after" ? at + 1 : at;
  return [...rest.slice(0, index), active, ...rest.slice(index)];
}
