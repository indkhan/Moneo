"use client";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Client-only and lazy so echarts stays out of Home's initial bundle.
const Chart = dynamic(() => import("@/components/chart").then(module => module.SpendingChart), {
  ssr: false, loading: () => <div aria-hidden="true" className="h-[200px] animate-pulse rounded-lg bg-muted" />,
});

// Clicking a month bar sets ?month= so the server re-renders the top lists for it.
export function TrendChart({ months, ...props }: { months: string[]; labels: string[]; values: number[]; height: number }) {
  const router = useRouter(), pathname = usePathname(), params = useSearchParams();
  return <Chart {...props} onSelect={index => {
    const next = new URLSearchParams(params);
    next.set("month", months[index]);
    router.replace(`${pathname}?${next}`, { scroll: false });
  }} />;
}
