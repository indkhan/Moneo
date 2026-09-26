"use client";

import dynamic from "next/dynamic";

const Chart = dynamic(() => import("echarts-for-react"), { ssr: false });

export function SpendingChart({ rows }: { rows: { posted_on: string; amount_minor: string }[] }) {
  const byDay = new Map<string, bigint>();
  for (const row of rows) {
    const amount = BigInt(row.amount_minor);
    if (amount < 0n) byDay.set(row.posted_on, (byDay.get(row.posted_on) ?? 0n) - amount);
  }
  const dates = [...byDay.keys()].sort();
  return <div className="mt-5" role="img" aria-label="Spending by day for the displayed transactions">
    <Chart style={{ height: 220 }} option={{
      tooltip: { trigger: "axis" }, xAxis: { type: "category", data: dates }, yAxis: { type: "value", name: "Minor units" },
      series: [{ type: "bar", data: dates.map(date => Number(byDay.get(date))) }],
    }} />
    <p className="text-xs text-muted-foreground">Chart covers displayed transactions only. Exact amounts appear below.</p>
  </div>;
}
