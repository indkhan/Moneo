"use client";

import dynamic from "next/dynamic";
import { dailySpending } from "@/lib/finance/calculations";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";

const Chart = dynamic(() => import("echarts-for-react"), { ssr: false });

export function SpendingChart({ rows, from, to, currency }: {
  rows: { posted_on: string; amount_minor: string; kind: string }[]; from: string; to: string; currency: string;
}) {
  const daily = dailySpending(rows.map(row => ({ date: row.posted_on, amountMinor: BigInt(row.amount_minor), kind: row.kind })), from, to);
  return <div className="mt-5" role="img" aria-label={`Net spending by day in ${currency} for the filtered period`}>
    <Chart style={{ height: 220 }} option={{
      tooltip: { trigger: "axis", renderMode: "richText", formatter: (items: { dataIndex: number }[]) => {
        const day = daily[items[0]?.dataIndex];
        return day ? `${day.date}\n${formatMoney(day.spendingMinor, currency)}` : "";
      } }, xAxis: { type: "category", data: daily.map(day => day.date) }, yAxis: { type: "value", name: currency },
      series: [{ type: "bar", data: daily.map(day => Number(formatInputAmount(day.spendingMinor, currency))) }],
    }} />
    <p className="text-xs text-muted-foreground">Full filtered period, including refunds and days with no spending. Chart coordinates are approximate; exact amounts appear below.</p>
  </div>;
}
