"use client";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

const loadChart = () => import("@/components/chart").then(module => module.CashFlowChart);
if (typeof window !== "undefined") { void loadChart(); void import("@/components/echarts-lean"); }
const Chart = dynamic(loadChart, {
  ssr: false, loading: () => <div aria-hidden="true" className="h-[240px] animate-pulse rounded-lg bg-muted" />,
});

export function TrendChart({ months, ...props }: { months: string[]; labels: string[]; income: bigint[]; spending: bigint[]; currency: string; locale?: string; flow?: "in" | "out"; selected?: number; picked?: "in" | "out"; height: number }) {
  const params = useSearchParams();
  return <Chart {...props} onSelect={(index, flow) => {
    const next = new URLSearchParams(params);
    next.set("month", months[index]);
    next.set("flow", flow);
    window.history.replaceState(null, "", `?${next}`);
  }} />;
}
