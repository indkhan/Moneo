import { describe, expect, it } from "vitest";
import { distanceToBox, dropSide, moveWidget } from "./home-grid-drop";

const box = { left: 100, right: 200, top: 100, bottom: 200 };

describe("dropSide", () => {
  it("is on the widget when the pointer is inside it", () => expect(dropSide(box, { x: 150, y: 150 })).toBe("on"));
  it("is after the widget in the empty space to its right", () => expect(dropSide(box, { x: 400, y: 150 })).toBe("after"));
  it("is after the widget below it", () => expect(dropSide(box, { x: 150, y: 400 })).toBe("after"));
  it("is before the widget above or to its left", () => {
    expect(dropSide(box, { x: 150, y: 50 })).toBe("before");
    expect(dropSide(box, { x: 50, y: 150 })).toBe("before");
  });
});

describe("distanceToBox", () => {
  it("is zero inside and prefers a far widget in the same row over a close one in another", () => {
    expect(distanceToBox(box, { x: 150, y: 150 })).toBe(0);
    expect(distanceToBox(box, { x: 900, y: 150 })).toBeLessThan(distanceToBox(box, { x: 150, y: 210 }));
  });
});

describe("moveWidget", () => {
  const items = ["a", "b", "c", "d"];
  it("takes the slot of the widget it lands on, either way", () => {
    expect(moveWidget(items, "a", "c", "on")).toEqual(["b", "c", "a", "d"]);
    expect(moveWidget(items, "d", "b", "on")).toEqual(["a", "d", "b", "c"]);
  });
  it("goes next to a widget when dropped in the space beside it", () => {
    expect(moveWidget(items, "d", "a", "after")).toEqual(["a", "d", "b", "c"]);
    expect(moveWidget(items, "a", "d", "after")).toEqual(["b", "c", "d", "a"]);
    expect(moveWidget(items, "d", "a", "before")).toEqual(["d", "a", "b", "c"]);
  });
  it("leaves the order alone for itself or unknown widgets", () => {
    expect(moveWidget(items, "a", "a", "on")).toBe(items);
    expect(moveWidget(items, "a", "z", "on")).toBe(items);
  });
});
