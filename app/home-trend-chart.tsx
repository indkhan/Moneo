"use client";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

// Client-only and lazy so echarts stays out of Home's initial bundle. Both chunks start
// downloading as soon as this module runs in the browser, instead of one after the other on render.
const loadChart = () => import("@/components/chart").then(module => module.CashFlowChart);
if (typeof window !== "undefined") { void loadChart(); void import("@/components/echarts-lean"); }
const Chart = dynamic(loadChart, {
  ssr: false, loading: () => <div aria-hidden="true" className="h-[240px] animate-pulse rounded-lg bg-muted" />,
});

// Clicking a bar sets ?month= and ?flow=; the breakdown for every month is already on the page, so no server round trip.
export function TrendChart({ months, ...props }: { months: string[]; labels: string[]; income: number[]; spending: number[]; flow?: "in" | "out"; selected?: number; picked?: "in" | "out"; height: number }) {
  const params = useSearchParams();
  return <Chart {...props} onSelect={(index, flow) => {
    const next = new URLSearchParams(params);
    next.set("month", months[index]);
    next.set("flow", flow);
    window.history.replaceState(null, "", `?${next}`);
  }} />;
}
