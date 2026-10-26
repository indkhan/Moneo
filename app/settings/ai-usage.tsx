import Link from "next/link";
import { requireWorkspace } from "@/lib/auth";
import { usageByModel, usageSince, usageWindows, type UsageWindow } from "@/lib/ai/usage";
import { UsageChart } from "./usage-chart";

// Enough recent requests to cover a busy workspace; the all-time view reads at most this many.
const ROW_LIMIT = 10_000;
const windowLabels: Record<UsageWindow, string> = { "7d": "7 days", "30d": "30 days", all: "All time" };

export async function AiUsage({ window }: { window: UsageWindow }) {
  const { supabase, workspace } = await requireWorkspace();
  const since = usageSince(window);
  const base = supabase.from("chat_requests").select("usage").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(ROW_LIMIT);
  const { data, error } = await (since ? base.gte("created_at", since) : base);
  const period = (
    <nav aria-label="Usage period" className="mt-4 flex flex-wrap gap-1">
      {usageWindows.map(value => <Link key={value} href={`?usage=${value}#usage`} scroll={false} aria-current={value === window ? "page" : undefined}
        className={`rounded-md px-2.5 py-1 text-sm ${value === window ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{windowLabels[value]}</Link>)}
    </nav>
  );
  if (error || !data) return <>{period}<p role="alert" className="mt-3 text-sm text-danger">AI usage is unavailable. Try again later.</p></>;
  const { models, unreported } = usageByModel(data);
  const format = new Intl.NumberFormat(workspace.locale);
  return <>
    {period}
    {models.length ? <div className="mt-4"><UsageChart models={models} locale={workspace.locale} /></div>
      : <p className="mt-4 text-sm text-muted-foreground">No AI chat requests with token counts in this period.</p>}
    <p className="mt-4 text-sm text-muted-foreground">
      {unreported ? `${format.format(unreported)} ${unreported === 1 ? "request" : "requests"} had no token count and ${unreported === 1 ? "is" : "are"} left out. ` : ""}
      Costs are not recorded.{data.length === ROW_LIMIT ? ` Showing the latest ${format.format(ROW_LIMIT)} requests.` : ""}
    </p>
  </>;
}
