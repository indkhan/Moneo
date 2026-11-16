import Link from "next/link";
import { FocusOnOpen } from "@/components/focus-on-open";
import { ScalablePositionChart } from "@/components/scalable-position-chart";
import { ScalablePositionNews } from "@/components/scalable-position-news";
import { requireWorkspace } from "@/lib/auth";
import { displayFormat } from "@/lib/display-format";
import type { WealthItem } from "@/lib/finance/wealth";
import { positionChartView } from "@/lib/scalable/chart-view";
import { loadPositionChart } from "@/lib/scalable/charts";

const shell = "fixed inset-y-0 right-0 z-50 w-full max-w-lg overflow-y-auto border-l border-border bg-card shadow-2xl";

export async function PositionDrawer({ isin, item }: { isin: string; item: WealthItem | null }) {
  const { supabase, workspace } = await requireWorkspace();
  const close = <Link href="/money/wealth" scroll={false} className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline hover:text-foreground">Close</Link>;
  if (!item) return <aside aria-label="Position details" className={`${shell} p-6`}>{close}<p role="alert" className="mt-4 text-sm">This position isn’t available.</p></aside>;
  const { money, dateTime } = displayFormat(workspace.locale, workspace.timezone);
  const views = positionChartView(await loadPositionChart(supabase, workspace.id, isin), { money, dateTime });
  const gain = item.cost_basis_minor === null ? null : BigInt(item.amount_minor) - BigInt(item.cost_basis_minor);
  return <aside aria-label="Position details" className={shell}>
    <FocusOnOpen label={`Details for ${item.name}`} />
    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-6 py-1">{close}<span className="font-mono text-[11px] text-subtle">{isin}</span></div>
    <div className="space-y-6 p-6">
      <header>
        <h2 className="font-display text-[28px] font-semibold leading-tight tracking-tight">{item.name}</h2>
        <p className="mt-1 font-mono text-[26px] tabular-nums">{money(item.amount_minor, item.currency_code)}</p>
        <p className="mt-1 text-xs text-muted-foreground">{item.quantity_text} shares{gain === null ? "" : ` · ${gain > 0n ? "+" : ""}${money(gain, item.currency_code)} since bought`}</p>
      </header>
      <ScalablePositionChart name={item.name} views={views} />
      <ScalablePositionNews isin={isin} />
    </div>
  </aside>;
}
