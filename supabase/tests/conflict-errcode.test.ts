import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

// PostgREST retries SQLSTATE 40001 until it succeeds, so a function that raises it for a
// deterministic conflict loops forever and drains the API pool. Raise PT409 (HTTP 409) instead.
it("raises conflicts as PT409 in migrations after the 40001 rewrite", () => {
  const dir = new URL("../migrations/", import.meta.url);
  const offenders = readdirSync(dir).filter(file => file > "202610310001" && /errcode\s*=\s*'40001'/i.test(readFileSync(new URL(file, dir), "utf8")));
  expect(offenders).toEqual([]);
});
