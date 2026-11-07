import { expect, it } from "vitest";
import { pageScriptErrors } from "./page-check";

it("finds a syntax error in a page's inline script without running it", () => {
  // The line that broke a real "Subscription radar" update: one closing parenthesis short.
  const broken = `<script>const ok = 1;\nconst list = data.filter(s => s && (s.a === "out" || (s.b != null && neg(s.b)) || (typeof s.c === "string")) : [];</script>`;
  const errors = pageScriptErrors(`<html><body><div id="x"></div>${broken}</body></html>`);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/^Script 1, line 2: /);
});

it("passes working scripts and ignores Moneo's chart library and data blocks", () => {
  const page = `<script src="/artifact-lib/echarts.min.js"></script><script type="application/json">{not js</script>
    <script>window.addEventListener("load", () => { document.title = "ok"; throw new Error("only at run time"); });</script>`;
  expect(pageScriptErrors(page)).toEqual([]);
});
