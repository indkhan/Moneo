import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { DatedTripForm } from "./dated-trip-form";
import { evaluateTripScenario, defaultTripScenario } from "@/lib/finance/trip-scenario";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
it("shows dated budget inputs, limiting date and a separate end-of-trip metric", () => {
  const scenario = defaultTripScenario("2026-10-01", "EUR", "checking", 20000n);
  const result = evaluateTripScenario({ startDate: "2026-10-01", horizonDays: 29, currencyCode: "EUR", accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: 10000n }], events: [{ accountId: "checking", date: "2026-10-03", expectedMinor: 100000n }] }, scenario);
  const html = renderToStaticMarkup(<DatedTripForm artifactId="synthetic" stateVersion={2} initial={scenario} initialResult={result} accounts={[{ id: "checking", currencyCode: "EUR" }]} />);
  expect(html).toContain("Trip start"); expect(html).toContain("Trip end"); expect(html).toContain("Payment date"); expect(html).toContain("Paying / receiving account");
  expect(html).toContain("2026-10-29"); expect(html).toContain("Limited on 2026-10-01");
  expect(html).toContain("End-of-trip headroom"); expect(html).toContain("EUR 900.00"); expect(html).toContain("EUR 100.00");
  expect(html).toContain("Save scenario"); expect(html).toContain("Undo local changes"); expect(html).toContain("External contribution");
});
