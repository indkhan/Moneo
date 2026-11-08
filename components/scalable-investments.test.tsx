import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ScalableInvestments } from "./scalable-investments";

vi.mock("@/lib/scalable/live", () => ({ PERIODS: {}, toMinor: (value: string) => value }));

const history = [{ date: "2025-01-02", value: 100000n }, { date: "2026-11-05", value: 500000n }];
const render = (over: Partial<Parameters<typeof ScalableInvestments>[0]> = {}) => renderToStaticMarkup(<ScalableInvestments positions={[]} history={history} calculatedBefore={null} historyFailed={false} syncedAt={null} active locale="en-GB" timeZone="UTC"
  portfolio={{ currency: "EUR", asOf: "2026-11-08", valuedAt: null, totalMinor: "500000", securitiesMinor: "0", cryptoMinor: "0", cashMinor: "500000", performance: [] }} {...over} />);

it("says which days are calculated, and leaves out a change that would mostly be money paid in", () => {
  const html = render({ calculatedBefore: "2026-11-05" });
  expect(html).toContain("are calculated from your transactions and past prices");
  expect(html).toContain("Prices further than a year back are monthly.");
  expect(html).not.toContain("since then");
});

it("keeps today's chart and change when nothing is calculated", () => {
  const html = render();
  expect(html).toContain("since then");
  expect(html).not.toContain("calculated");
  expect(html).not.toContain("could not be worked out");
});

it("says little when the history failed its check", () => {
  const html = render({ historyFailed: true });
  expect(html).toContain("Earlier days could not be worked out");
  expect(html).toContain("since then");
  expect(html).not.toMatch(/mismatch|error|failed/i);
});
