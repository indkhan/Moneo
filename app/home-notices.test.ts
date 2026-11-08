import { expect, it } from "vitest";
import { nextNotices } from "./home-notices";

const notice = (text: string) => ({ text, href: "/money/wealth", action: "Review" });

it("shows a problem once, and only what is new after that", () => {
  const first = nextNotices([notice("old value")], []);
  expect(first.fresh.map(row => row.text)).toEqual(["old value"]);
  const again = nextNotices([notice("old value")], first.seen);
  expect(again.fresh).toEqual([]);
  expect(nextNotices([notice("old value"), notice("sync failed")], again.seen).fresh.map(row => row.text)).toEqual(["sync failed"]);
});

it("shows a problem again when it went away and came back, or changed", () => {
  const gone = nextNotices([], ["old value"]);
  expect(gone.seen).toEqual([]);
  expect(nextNotices([notice("old value")], gone.seen).fresh).toHaveLength(1);
  expect(nextNotices([notice("older value")], ["old value"]).fresh).toHaveLength(1);
});
