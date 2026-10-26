"use client";

import ReactEChartsCore from "echarts-for-react/lib/core";
import type { EChartsReactProps } from "echarts-for-react/lib/types";
import * as echarts from "echarts/core";
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

// Only what the app's own charts draw; model-written answer charts load the full build instead.
echarts.use([BarChart, LineChart, ScatterChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

export default function LeanECharts(props: Omit<EChartsReactProps, "echarts">) {
  return <ReactEChartsCore echarts={echarts} {...props} />;
}
