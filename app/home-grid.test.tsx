import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { HomeGrid } from "./home-grid";

it("lays widgets out in normal rows until it has measured them", () => {
  // Masonry rows are 4px and each widget's span is measured after hydration; before that every widget spanned
  // one 4px row, so the server-rendered Home drew widgets on top of each other.
  const html = renderToStaticMarkup(<HomeGrid version={1} items={["a", "b"]} sizes={{ a: "M", b: "M" }} widgets={{ a: <p>A</p>, b: <p>B</p> }} labels={{ a: "A", b: "B" }} options={{}} />);
  const grid = /<div class="(grid items-start[^"]*)"/.exec(html)?.[1] ?? "";
  const masonry = grid.split(" ").filter(name => /auto-rows-\[4px\]|grid-row-end|gap-y-0/.test(name));
  expect(masonry.length).toBeGreaterThan(0);
  expect(masonry.every(name => name.includes("data-masonry"))).toBe(true);
});
