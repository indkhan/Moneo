import type { tripForArtifact } from "@/lib/artifacts/finance-sdk";
import { formatMoney } from "@/lib/finance/format";

export type ForecastEvidenceInput = { accountId?: string | null; liquidity?: Awaited<ReturnType<typeof tripForArtifact>>["liquidity"] };
export function ForecastEvidence({ evidence, locale }: { evidence: ForecastEvidenceInput; locale?: string }) {
  const liquidity = evidence.liquidity;
  if (!liquidity) return null;
  if (liquidity.status === "unavailable") return <p role="alert">Forecast unavailable: {liquidity.missingInputs.join(", ")}</p>;
  const selected = liquidity.accounts.find(account => account.accountId === evidence.accountId);
  const money = (amount: string) => formatMoney(amount, liquidity.currencyCode, locale);
  return <div className="mt-3 rounded-lg border border-border bg-card p-4 text-sm">
    <h3 className="font-semibold">Host forecast evidence</h3>
    <p>Aggregate headroom: {money(liquidity.aggregate.amountMinor)} on {liquidity.aggregate.limitingDate}. This is combined protection-adjusted cash, not chosen-account affordability.</p>
    <p>Workspace buffer: {money(liquidity.workspaceBufferMinor)}, protected once across all accounts.</p>
    {selected ? <p>Chosen-account headroom - {selected.accountId}: {money(selected.spendableMinor)} on {selected.spendingLimitingDate}. Account liquidity {money(selected.amountMinor)} on {selected.limitingDate}; owned protections {money(selected.protectedMinor)}.</p> : <p>Choose a paying account in Plan preferences before evaluating affordability.</p>}
    {liquidity.workspaceBufferPressureMinor !== "0" && <p role="alert">Workspace buffer pressure: {money(liquidity.workspaceBufferPressureMinor)}.</p>}
    {liquidity.accounts.map(account => <div key={account.accountId}>
      {account.shortfallMinor !== "0" && <p role="alert">{account.accountId} funding shortfall: {money(account.shortfallMinor)}. First shortfall {account.firstShortfallDate}; limiting date {account.limitingDate}.</p>}
      {account.supportingEvents.map((event, index) => <p key={index}>{event.date} ? {account.accountId} ? {event.name ?? event.source ?? "Payment"}: {money(event.conservativeMinor)}</p>)}
    </div>)}
    <p>No automatic funding from other accounts. Only explicit paired dated funding can resolve account gaps; donor and workspace protections still apply. <a href={evidence.accountId ? `/plan?account=${encodeURIComponent(evidence.accountId)}` : "/plan"} className="text-brand underline">Review paying account and dated funding</a></p>
  </div>;
}
