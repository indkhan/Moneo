import { expect, it } from "vitest";

it("proves failed checks return a nonzero exit", () => {
  expect("failure sentinel").toBe("passing sentinel");
});
