"use client";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Client-only and lazy so echarts stays out of Home's initial bundle.
const Chart = dynamic(() => import("@/components/chart").then(module => module.CashFlowChart), {
  ssr: false, loading: () => <div aria-hidden="true" className="h-[240px] animate-pulse rounded-lg bg-muted" />,
});

// Clicking a bar sets ?month= and ?flow= so the server re-renders that month's breakdown.
export function TrendChart({ months, ...props }: { months: string[]; labels: string[]; income: number[]; spending: number[]; flow?: "in" | "out"; selected?: number; picked?: "in" | "out"; height: number }) {
  const router = useRouter(), pathname = usePathname(), params = useSearchParams();
  return <Chart {...props} onSelect={(index, flow) => {
    const next = new URLSearchParams(params);
    next.set("month", months[index]);
    next.set("flow", flow);
    router.replace(`${pathname}?${next}`, { scroll: false });
  }} />;
}
