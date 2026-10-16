import { accountLiquidity, forecastDaily, withInternalFunding, type ForecastInput } from "@/lib/finance/calculations";
import { forecastInput } from "@/lib/finance/tools";
import { describeMissingInputs, formatMoney } from "@/lib/finance/format";
import { positiveMinor, field } from "./ui";

export type LiquidityParams = { horizon?: string; scenario?: string; account?: string; fundingFrom?: string; fundingDate?: string; funding?: string };

export function planLiquidity(input: ForecastInput, params: LiquidityParams) {
  let appliedInput = input;
  let fundingError: string | null = null;
  let fundingMinor: string | null = null;
  if (params.fundingFrom || params.fundingDate || params.funding) {
    // Decimal currency input becomes exact minor units here, before the shared schema validates it.
    fundingMinor = positiveMinor(params.funding ?? "", input.currencyCode);
    const parsed = forecastInput.safeParse({ funding: [{ fromAccountId: params.fundingFrom, toAccountId: params.account,
      date: params.fundingDate, amountMinor: fundingMinor ?? undefined, currencyCode: input.currencyCode }] });
    if (!parsed.success) fundingError = "Choose two different liquid accounts, a date within the horizon, and a positive amount.";
    else try { appliedInput = withInternalFunding(input, parsed.data.funding!.map(item => ({ ...item, amountMinor: BigInt(item.amountMinor) }))); }
    catch (error) { fundingError = error instanceof Error ? error.message : "Invalid funding"; }
  }
  return { liquidity: accountLiquidity(appliedInput), forecast: forecastDaily(appliedInput), fundingError, fundingMinor };
}

export function AccountHeadroom({ input, params, names, locale, result }: {
  input: ForecastInput; params: LiquidityParams; names: Map<string, string>; locale?: string; result: ReturnType<typeof planLiquidity>;
}) {
  const { liquidity, fundingError, fundingMinor } = result;
  const money = (amount: bigint) => formatMoney(amount, input.currencyCode, locale);
  const selected = liquidity.status === "available" ? liquidity.accounts.find(account => account.accountId === params.account) : undefined;
  const invalidAccount = params.account && !input.accounts.some(account => account.id === params.account);
  return <div className="space-y-5">
    <form method="get" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="horizon" value={params.horizon ?? input.horizonDays} />
      {params.scenario && <input type="hidden" name="scenario" value={params.scenario} />}
      <label className="grid gap-1 text-sm font-medium">Paying account<select name="account" defaultValue={params.account ?? ""} className={field}>
        <option value="">Choose a paying account</option>{invalidAccount && <option value={params.account}>Unavailable account</option>}
        {input.accounts.map(account => <option key={account.id} value={account.id}>{names.get(account.id) ?? account.id}</option>)}
      </select></label>
      <label className="grid gap-1 text-sm font-medium">Fund from (optional)<select name="fundingFrom" defaultValue={params.fundingFrom ?? ""} className={field}>
        <option value="">No funding</option>{params.fundingFrom && !input.accounts.some(account => account.id === params.fundingFrom) && <option value={params.fundingFrom}>Unavailable account</option>}
        {input.accounts.map(account => <option key={account.id} value={account.id}>{names.get(account.id) ?? account.id}</option>)}
      </select></label>
      <label className="grid gap-1 text-sm font-medium">Funding date<input type="date" name="fundingDate" defaultValue={params.fundingDate ?? ""} className={field} /></label>
      <label className="grid gap-1 text-sm font-medium">Funding amount ({input.currencyCode})<input name="funding" inputMode="decimal" placeholder="0.00" defaultValue={params.funding ?? ""} className={field} /></label>
      <button className="min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Evaluate account</button>
    </form>
    <p className="text-sm text-muted-foreground">No automatic transfer from another account. Funding here is only a what-if; your real balances do not change.</p>
    {fundingError && <p role="alert" className="text-sm text-foreground font-medium">Funding was not applied: {fundingError}</p>}
    {invalidAccount && <p role="alert" className="text-sm text-foreground font-medium">Choose a current liquid account.</p>}
    {liquidity.status === "unavailable" ? <div role="alert" className="text-sm"><p className="font-medium">Forecast unavailable</p><ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{describeMissingInputs(liquidity.missingInputs, names).map(item => <li key={item}>{item}</li>)}</ul></div> : <>
      <div className="rounded-lg bg-muted/60 p-4"><h3 className="font-semibold">Aggregate headroom</h3><p className="font-mono text-2xl">{money(liquidity.aggregate.amountMinor)}</p><p className="text-sm text-muted-foreground">Lowest combined cash after protections, on {liquidity.aggregate.limitingDate}.</p></div>
    <p className="text-sm text-muted-foreground">Workspace buffer: {money(liquidity.workspaceBufferMinor)}, kept once across all accounts. Chosen-account spending is limited by both account liquidity and aggregate headroom.</p>
    {liquidity.workspaceBufferPressureMinor > 0n && <p role="alert" className="text-sm">Workspace buffer pressure: {money(liquidity.workspaceBufferPressureMinor)} on {liquidity.aggregate.limitingDate}.</p>}
      {selected ? <div className="rounded-lg border border-border p-4"><h3 className="font-semibold">Chosen-account headroom — {names.get(selected.accountId) ?? selected.accountId}</h3><p className="font-mono text-2xl">{money(selected.spendableMinor)}</p><p className="text-sm">Tightest day {selected.spendingLimitingDate}, after protections. Account cash: {money(selected.amountMinor)} on {selected.limitingDate}. {selected.shortfallMinor > 0n ? "Funding is needed before spending more." : "Extra spending should stay within this amount."}</p></div> : <p className="text-sm text-muted-foreground">Choose a paying account to evaluate spending.</p>}
      {params.fundingFrom && !fundingError && <p className="text-sm">Hypothetical funding: {names.get(params.fundingFrom) ?? params.fundingFrom} to {names.get(params.account ?? "") ?? params.account}, {money(BigInt(fundingMinor!))} on {params.fundingDate}.</p>}
      <div className="grid gap-4 sm:grid-cols-2">{liquidity.accounts.map(account => {
        const source = input.accounts.find(item => item.id === account.accountId)!;
        const name = names.get(account.accountId) ?? account.accountId;
        return <article key={account.accountId} className="rounded-lg border border-border p-4">
          <h3 className="font-semibold">{name}</h3>
          {account.shortfallMinor > 0n && <p role="alert" className="mt-2 text-foreground font-medium">{name} funding shortfall: {money(account.shortfallMinor)}. First shortfall {account.firstShortfallDate}; limiting date {account.limitingDate}.</p>}
          <p className="text-sm">Cash {money(account.amountMinor)} on {account.limitingDate}. Protected: {money(account.protectedMinor)}.</p>
          <ul className="mt-2 text-sm text-muted-foreground"><li>Goal reservations: {money(source.reservedMinor ?? 0n)}</li><li>Minimum balance: {money(source.minimumMinor ?? 0n)}</li><li>Safety buffer: {money(source.safetyBufferMinor ?? 0n)}</li></ul>
          <p className="mt-2 text-sm">Payments until then:</p>
          <ul className="mt-1 space-y-1 text-sm">{account.supportingEvents.map((event, index) => <li key={index}>{event.date} · {name} · {event.name ?? "Forecast movement"} · Conservative {money(event.conservativeMinor ?? event.expectedMinor)}</li>)}</ul>
          {!account.supportingEvents.length && <p className="text-sm text-muted-foreground">No payments before this low point.</p>}
        </article>;
      })}</div>
    </>}
  </div>;
}

