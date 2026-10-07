import { expect, it, vi } from "vitest";
import { accountLiquidity, availableToSpend, forecastDaily, serializeAccountLiquidity } from "./calculations";
import { evaluateForecast } from "./tools";
import { tripForArtifact } from "../artifacts/finance-sdk";
import { buildCalculatorSnapshot } from "../artifacts/snapshot";
import { toolResultReceipt } from "./tool-evidence";
const fixture = vi.hoisted(() => ({ spendingAccountId: "checking" as string | null, input: {
  workspaceBufferMinor: 0n, startDate: "2026-10-07", horizonDays: 30, currencyCode: "EUR",
  accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: 10000n }, { id: "savings", currencyCode: "EUR", balanceMinor: 100000n }],
  events: [{ date: "2026-10-08", accountId: "checking", expectedMinor: -50000n, name: "Bill" }],
} }));
vi.mock("./model", async () => {
  const c = await import("./calculations");
  const plan = async () => ({ input: fixture.input, forecast: c.forecastDaily(fixture.input), available: c.availableToSpend(fixture.input), liquidity: c.accountLiquidity(fixture.input), preferences: { spending_account_id: fixture.spendingAccountId } });
  return { evaluatePlan: plan, evaluatePlanForWorkspace: plan };
});
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => {
  const query = { select: () => query, eq: () => query, single: async () => ({ data: { permissions: ["forecast"], active_version_id: "v" } }) };
  return { workspace: { display_currency: "EUR", timezone: "Europe/Berlin" }, supabase: { from: () => query } };
} }));
it.each([false, true])("receipts use each real forecast metric's own limiting date (local cap=%s)", async localCap => {
  const original = fixture.input;
  try {
    fixture.input = { ...original, workspaceBufferMinor: 200n, horizonDays: 3,
      accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: localCap ? 100n : 1000n }, { id: "savings", currencyCode: "EUR", balanceMinor: 1000n }],
      events: [{ date: "2026-10-08", accountId: "savings", expectedMinor: localCap ? -200n : -1500n, name: "Bill" }] };
    const result = await evaluateForecast({ horizonDays: 3, accountId: "checking" });
    const receipt = toolResultReceipt("forecast_evaluate", {}, result, { workspaceId: "00000000-0000-4000-8000-000000000001", fetchedAt: "2026-10-07T12:00:00Z", timezone: "UTC" }, ["accounts", "transactions", "planning"]);
    const metric = (id: string) => receipt.metrics.find(metric => metric.id === id)!;
    expect(metric("liquidity.accounts.0.spendableMinor")).toMatchObject({ valueMinor: localCap ? "100" : "300", period: { from: "2026-10-07", to: "2026-10-09" } });
    expect(metric("liquidity.accounts.0.spendableMinor").calculation).toContain(`Limiting date: ${localCap ? "2026-10-07" : "2026-10-08"}`);
    expect(metric("liquidity.accounts.0.amountMinor").calculation).toContain("Limiting date: 2026-10-07");
    expect(metric("availableToSpendMinor").calculation).toContain(`Limiting date: ${localCap ? "2026-10-07" : "2026-10-08"}`);
    expect(metric("aggregateAvailableMinor").calculation).toContain("Limiting date: 2026-10-08");
  } finally { fixture.input = original; }
});
it("AI and artifact expose the shared account, protection and limiting date without pooling", async () => {
  const expected = serializeAccountLiquidity(accountLiquidity(fixture.input));
  const ai = await evaluateForecast({ horizonDays: 30, accountId: "checking" });
  expect(ai).toMatchObject({ liquidity: expected, aggregateAvailableMinor: "60000", availableToSpendMinor: "-40000", accountId: "checking", limitingDate: "2026-10-08" });
  expect(ai).toMatchObject({ period: { from: "2026-10-07", to: "2026-11-05" }, calculationEvidence: { input: { accounts: [expect.objectContaining({ id: "checking", balanceMinor: "10000" }), expect.objectContaining({ id: "savings", balanceMinor: "100000" })] } } });
  expect(await evaluateForecast({ horizonDays: 30 })).toMatchObject({ availableToSpendMinor: null, aggregateAvailableMinor: "60000" });
  await expect(evaluateForecast({ accountId: "unknown" })).rejects.toThrow("Unknown account");
  const artifact = await tripForArtifact("synthetic", 100n, "checking");
  expect(artifact.liquidity).toEqual(expected);
  expect(artifact.baseline).toMatchObject({ amountMinor: -40000n, limitingDate: "2026-10-08" });
  expect(artifact.withTrip).toMatchObject({ amountMinor: -40100n });
  expect((await buildCalculatorSnapshot("synthetic", "trip_planner", { costMinor: 100n, accountId: "checking" })).snapshot).toMatchObject({
    baselineAvailableMinor: "-40000", accountId: "checking", liquidity: expected,
  });
  expect(availableToSpend(fixture.input)).toMatchObject({ amountMinor: 60000n });
  expect(forecastDaily(fixture.input).status).toBe("available");
});
it("AI evaluates explicit dated paired funding without changing the real plan", async () => {
  const funding = { date: "2026-10-08", currencyCode: "EUR", fromAccountId: "savings", toAccountId: "checking", amountMinor: "40000" };
  expect(await evaluateForecast({ accountId: "checking", funding: [funding] })).toMatchObject({ availableToSpendMinor: "0", aggregateAvailableMinor: "60000" });
  expect(await evaluateForecast({ accountId: "checking", funding: [{ ...funding, date: "2026-10-09" }] })).toMatchObject({ availableToSpendMinor: "-40000", limitingDate: "2026-10-08" });
  await expect(evaluateForecast({ funding: [{ ...funding, currencyCode: "USD" }] })).rejects.toThrow("Funding currency");
  expect(fixture.input.events).toHaveLength(1);
});
it("artifact with no paying account exposes gaps but cannot claim pooled spending", async () => {
  fixture.spendingAccountId = null;
  try {
    expect(await tripForArtifact("synthetic", 100n)).toMatchObject({ baseline: { status: "unavailable" }, accountId: null,
      liquidity: { aggregate: { amountMinor: "60000" }, hasShortfall: true },
      unavailable: "Choose a paying account; aggregate cash requires explicit funding" });
  } finally { fixture.spendingAccountId = "checking"; }
});

it("AI, artifact SDK and snapshot cap chosen-account spending by workspace protection", async () => {
  fixture.input.workspaceBufferMinor = 10000n;
  try {
    const expected = serializeAccountLiquidity(accountLiquidity(fixture.input));
    expect(await evaluateForecast({ accountId: "savings" })).toMatchObject({ availableToSpendMinor: "50000", limitingDate: "2026-10-08", liquidity: expected });
    expect(await tripForArtifact("synthetic", 100n, "savings")).toMatchObject({ baseline: { amountMinor: 50000n, limitingDate: "2026-10-08" }, liquidity: expected });
    expect((await buildCalculatorSnapshot("synthetic", "trip_planner", { costMinor: 100n, accountId: "savings" })).snapshot).toMatchObject({ baselineAvailableMinor: "50000", liquidity: expected });
  } finally { fixture.input.workspaceBufferMinor = 0n; }
});

it("artifact SDK uses the same explicit paired funding dates as AI", async () => {
  const funding = { date: "2026-10-08", currencyCode: "EUR", fromAccountId: "savings", toAccountId: "checking", amountMinor: 40000n };
  expect(await tripForArtifact("synthetic", 0n, "checking", [funding])).toMatchObject({ baseline: { amountMinor: 0n } });
  expect(await tripForArtifact("synthetic", 0n, "checking", [{ ...funding, date: "2026-10-09" }])).toMatchObject({ baseline: { amountMinor: -40000n, limitingDate: "2026-10-08" } });
  expect(fixture.input.events).toHaveLength(1);
});
