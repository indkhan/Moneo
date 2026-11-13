"use client";

import ReactEChartsCore from "echarts-for-react/lib/core";
import type { EChartsReactProps } from "echarts-for-react/lib/types";
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, PieChart, SankeyChart, ScatterChart, TreemapChart } from "echarts/charts";
import { CalendarComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, VisualMapContinuousComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

// Only the chart types the app draws, app-owned and model-written alike.
// Sankey, heatmap, calendar and the continuous visual map draw chat's flow and daily-spending charts.
echarts.use([BarChart, LineChart, ScatterChart, PieChart, TreemapChart, SankeyChart, HeatmapChart, CalendarComponent, VisualMapContinuousComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

export default function LeanECharts(props: Omit<EChartsReactProps, "echarts">) {
  return <ReactEChartsCore echarts={echarts} {...props} />;
}
