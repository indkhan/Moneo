import { z } from "zod";
import type { EvidenceReceipt } from "@/lib/finance/evidence-receipts";

/** App-written chart block. The model never writes it; it is built from accepted, verified metric claims. */
export const answerChartSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  rows: z.array(z.object({
    label: z.string().min(1).max(240),
    valueMinor: z.string().regex(/^-?(?:0|[1-9]\d{0,79})$/),
    href: z.string().max(500).regex(/^\/money\/transactions\?[\w=&%.-]*$/).optional(),
  }).strict()).min(2).max(20),
}).strict();
export type AnswerChart = z.infer<typeof answerChartSchema>;
type AcceptedClaim = { operation: string; operands: { receiptId: string; metricId: string }[]; valueMinor: string; currency: string; unit: string };

const uuid = z.uuid();

/** Filtered transactions for a metric: its period, plus direction and account when the evidence names them. */
function transactionsHref(metric: EvidenceReceipt["metrics"][number], receipt: EvidenceReceipt) {
  const params = new URLSearchParams({ from: metric.period.from, to: metric.period.to });
  if (/(^|\.)incomeMinor$/.test(metric.id)) params.set("direction", "income");
  if (/(^|\.)spendingMinor$/.test(metric.id)) params.set("direction", "outflow");
  const input = receipt.query.input;
  const account = input && typeof input === "object" && !Array.isArray(input) ? input.accountId : undefined;
  if (uuid.safeParse(account).success) params.set("account", account as string);
  return `/money/transactions?${params}`;
}

export function answerChart(accepted: AcceptedClaim[], receipts: EvidenceReceipt[], workspaceId: string): AnswerChart | null {
  const byCurrency = new Map<string, AnswerChart["rows"]>();
  for (const claim of accepted) {
    if (claim.operation !== "metric" || claim.unit !== "money" || claim.operands.length !== 1) continue;
    const receipt = receipts.find(item => item.id === claim.operands[0].receiptId && item.workspaceId === workspaceId);
    const metric = receipt?.metrics.find(item => item.id === claim.operands[0].metricId);
    if (!receipt || !metric || metric.valueMinor !== claim.valueMinor || metric.currency !== claim.currency) continue;
    const rows = byCurrency.get(claim.currency) ?? [];
    const label = `${metric.label} · ${metric.period.from === metric.period.to ? metric.period.from : `${metric.period.from} to ${metric.period.to}`}`;
    if (!rows.some(row => row.label === label)) rows.push({ label, valueMinor: claim.valueMinor, href: transactionsHref(metric, receipt) });
    byCurrency.set(claim.currency, rows);
  }
  const [currency, rows] = [...byCurrency].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  return currency && rows && rows.length >= 2 ? { currency, rows: rows.slice(0, 20) } : null;
}

/** Places the chart after the measured facts and before the evidence trail. */
export function withAnswerChart(body: string, chart: AnswerChart | null) {
  if (!chart) return body;
  const block = `\`\`\`moneo-chart\n${JSON.stringify(chart)}\n\`\`\``;
  const trail = body.lastIndexOf("\n\nEvidence trail\n\n");
  return trail < 0 ? `${body}\n\n${block}` : `${body.slice(0, trail)}\n\n${block}${body.slice(trail)}`;
}
