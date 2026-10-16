"use client";
import dynamic from "next/dynamic";

// Client-only and lazy so echarts stays out of Home's initial bundle.
export const TrendChart = dynamic(() => import("@/components/chart").then(module => module.SpendingChart), {
  ssr: false, loading: () => <div aria-hidden="true" className="h-[200px] animate-pulse rounded-lg bg-muted" />,
});
