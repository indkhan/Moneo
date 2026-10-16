"use client";

import { useMemo, useSyncExternalStore } from "react";
import ReactECharts from "echarts-for-react";

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

// Chart colors follow the app's CSS tokens, including the dark theme.
function useThemeColors() {
  const theme = useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme ?? "light", () => "light");
  return useMemo(() => {
    const fallback = theme === "dark" ? { brand: "#83b3ff", muted: "#b1c0d5", border: "#3a4a62" } : { brand: "#0051d5", muted: "#57677c", border: "#dce5f2" };
    if (typeof document === "undefined") return fallback;
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, value: string) => style.getPropertyValue(name).trim() || value;
    return { brand: read("--color-brand", fallback.brand), muted: read("--color-muted-foreground", fallback.muted), border: read("--color-border", fallback.border) };
  }, [theme]);
}

export function SpendingChart({ values, labels, type = "bar", height = 280, ariaLabel, formatValue }: {
  values: number[];
  labels?: string[];
  type?: "bar" | "line";
  height?: number;
  ariaLabel?: string;
  formatValue?: (value: number) => string;
}) {
  const colors = useThemeColors();
  const axis = { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted }, splitLine: { lineStyle: { color: colors.border } } };
  return (
    <div role={ariaLabel ? "img" : undefined} aria-label={ariaLabel}>
      <ReactECharts
        option={{
          color: [colors.brand],
          grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
          tooltip: { trigger: "axis", ...(formatValue ? { valueFormatter: formatValue } : {}) },
          xAxis: { type: "category", data: labels ?? values.map((_, i) => `W${i + 1}`), ...axis },
          yAxis: { type: "value", ...axis, ...(formatValue ? { axisLabel: { color: colors.muted, formatter: formatValue } } : {}) },
          series: [{ type, data: values, ...(type === "line" ? { smooth: true, showSymbol: false, areaStyle: { opacity: 0.12 } } : { barMaxWidth: 28, itemStyle: { borderRadius: [4, 4, 0, 0] } }) }],
        }}
        style={{ height }}
      />
    </div>
  );
}
