import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { displayFormat } from "@/lib/display-format";
import { loadNetWorthEvidence, netWorthModel } from "@/lib/finance/net-worth-source";
import { latestPortfolio } from "@/lib/scalable/holding";
import { scalablePortfolioHistory } from "@/lib/scalable/portfolio-history";
import { valueHistoryView } from "@/lib/scalable/value-history";

export async function GET() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const { supabase, workspace } = context;
  try {
    const [evidence, portfolio] = await Promise.all([loadNetWorthEvidence(supabase, workspace), latestPortfolio(supabase, workspace.id)]);
    if (!portfolio) return NextResponse.json({ error: "Scalable has not synced yet." }, { status: 404 });
    const model = netWorthModel(evidence);
    const { points, calculatedBefore } = scalablePortfolioHistory({ evidence, model, portfolio, today: model.today, timeZone: workspace.timezone });
    const entries = points.map(point => ({ date: point.date, valueMinor: point.value, priceMinor: null, shares: null, trades: [], calculated: calculatedBefore !== null && point.date < calculatedBefore }));
    return NextResponse.json(valueHistoryView(entries, portfolio.currency, displayFormat(workspace.locale, workspace.timezone)), { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "The portfolio history could not be loaded." }, { status: 500 }); }
}
