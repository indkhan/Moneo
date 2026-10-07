import { z } from "zod";
import { formatMoney } from "./format";

export type FinancialEvidenceReceipt = {
  id: string; workspaceId: string; fetchedAt: string; calculationVersion: string; sourceVersion: string;
  query: unknown;
  sources: { id: string; type: string; version: string; href: string }[];
  metrics: { id: string; label: string; valueMinor: string | null; currency: string; unit?: "money" | "count"; period: { from: string; to: string }; qualifiers: string[]; sourceIds: string[]; calculation: string }[];
};
const periodSchema = z.object({ from: z.iso.date(), to: z.iso.date() }).strict().refine(value => value.from <= value.to);
const referenceSchema = z.object({ receiptId: z.uuid(), metricId: z.string().min(1).max(200) }).strict();
export const financialClaimSchema = z.object({
  operation: z.enum(["metric", "sum", "difference"]),
  operands: z.array(referenceSchema).min(1).max(20),
  valueMinor: z.string().regex(/^-?(?:0|[1-9]\d{0,79})$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  unit: z.enum(["money", "count"]).default("money"),
  periods: z.array(periodSchema).min(1).max(20),
  qualifiers: z.array(z.string().min(1).max(100)).max(30),
  sourceIds: z.array(z.string().min(1).max(200)).max(20000).optional(),
  direction: z.enum(["increase", "decrease", "unchanged"]).optional(),
}).strict();
const interpretationSchema = z.object({
  action: z.enum(["review", "consider", "ask"]), reference: referenceSchema,
  topic: z.enum(["classification", "supporting_records", "budget", "timing", "recurring", "goals", "assumptions"]),
}).strict();
export const financialAnswerSchema = z.object({
  claims: z.array(financialClaimSchema).max(100), interpretation: z.array(interpretationSchema).max(20),
}).strict();
type Claim = z.infer<typeof financialClaimSchema>;
const qualifications: Record<string, string> = {
  partial_classification: "Partial classification: unresolved rows are excluded; totals may rise or fall and are neither upper nor lower bounds.",
  partial_coverage: "Partial coverage: the records do not establish complete financial activity for this period.",
  unresolved_included: "Unresolved classifications are included as source evidence, not confirmed spending.",
  dated_snapshot: "Dated snapshot: this measures retained evidence, not a live balance.",
  assumption: "Assumption: this projection is conditional and is not a probability or established outcome.",
  manual_evidence: "Manual evidence: a dated recorded value, not a verified current balance.",
  virtual_reservation: "Virtual reservation: an earmark, not money moved or spent.",
  source_posting: "Recorded source posting: this is the canonical parent amount; effective allocations and verified fees determine financial totals. Do not add the parent to its components.",
};
function sameSet(a: string[], b: string[]) {
  return a.length === new Set(a).size && b.length === new Set(b).size && a.length === b.length && a.every(value => b.includes(value));
}
function escapeMarkdown(value: string) { return value.replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&").replace(/[\r\n]/g, " "); }
export function financialMetricHref(receiptId: string, metricId: string) {
  return `/ai/evidence/${encodeURIComponent(receiptId)}?metric=${encodeURIComponent(metricId)}`;
}
function resolve(reference: z.infer<typeof referenceSchema>, receipts: FinancialEvidenceReceipt[], workspaceId: string) {
  const matching = receipts.filter(receipt => receipt.id === reference.receiptId && receipt.workspaceId === workspaceId);
  if (matching.length !== 1) throw new Error("Evidence ownership or identity is invalid");
  const receipt = matching[0], metrics = receipt.metrics.filter(metric => metric.id === reference.metricId);
  if (metrics.length !== 1 || metrics[0].valueMinor === null) throw new Error("Metric unavailable");
  const metric = metrics[0];
  if (!/^-?(?:0|[1-9]\d{0,79})$/.test(metric.valueMinor!) || !periodSchema.safeParse(metric.period).success
    || metric.qualifiers.some(value => !Object.hasOwn(qualifications, value))) throw new Error("Invalid deterministic metric");
  for (const id of metric.sourceIds) {
    const sources = receipt.sources.filter(source => source.id === id);
    if (sources.length !== 1) throw new Error("Missing supporting source");
  }
  return { receipt, metric, value: BigInt(metric.valueMinor!) };
}
export function publishFinancialClaims(input: unknown, receipts: FinancialEvidenceReceipt[], workspaceId: string) {
  const envelope = z.object({ claims: z.array(z.unknown()).max(100), interpretation: z.array(z.unknown()).max(20) }).strict().safeParse(input);
  const accepted: Claim[] = [], measured: string[] = [], interpretation: string[] = [];
  let removed = envelope.success ? 0 : 1;
  for (const raw of envelope.success ? envelope.data.claims : []) {
    try {
      const claim = financialClaimSchema.parse(raw);
      if ((claim.operation === "metric" && claim.operands.length !== 1) || (claim.operation === "difference" && claim.operands.length !== 2)) throw new Error("Invalid operands");
      const evidence = claim.operands.map(reference => resolve(reference, receipts, workspaceId));
      if (new Set(claim.operands.map(reference => JSON.stringify(reference))).size !== claim.operands.length || evidence.some(({ metric }) => (metric.unit ?? "money") !== claim.unit)) throw new Error("Duplicate operands or incompatible units");
      if (evidence.some(({ metric }) => metric.currency !== claim.currency)) throw new Error("Currency mismatch");
      if (claim.periods.length !== evidence.length || evidence.some(({ metric }, index) => JSON.stringify(metric.period) !== JSON.stringify(claim.periods[index]))) throw new Error("Period mismatch");
      if (claim.operation === "sum" && evidence.some(({ metric }) => metric.period.from !== evidence[0].metric.period.from || metric.period.to !== evidence[0].metric.period.to)) throw new Error("Sum period mismatch");
      const required = [...new Set(evidence.flatMap(({ metric }) => metric.qualifiers))];
      const sources = [...new Set(evidence.flatMap(({ metric }) => metric.sourceIds))];
      if (!sameSet(claim.qualifiers, required) || claim.sourceIds && !sameSet(claim.sourceIds, sources)) throw new Error("Missing qualifiers or invalid links");
      const value = claim.operation === "difference" ? evidence[0].value - evidence[1].value : evidence.reduce((sum, item) => sum + item.value, 0n);
      if (value !== BigInt(claim.valueMinor)) throw new Error("Incorrect arithmetic");
      const direction = value > 0n ? "increase" : value < 0n ? "decrease" : "unchanged";
      if (claim.direction && (claim.operation !== "difference" || claim.direction !== direction)) throw new Error("Incorrect comparison");
      const links = evidence.map(({ receipt, metric }) => `[${escapeMarkdown(metric.label)} (${metric.period.from} to ${metric.period.to})](${financialMetricHref(receipt.id, metric.id)})`);
      measured.push(`- ${claim.operation === "difference" ? `Change (${direction}) in ` : claim.operation === "sum" ? "Sum of " : ""}${links.join(claim.operation === "difference" ? " compared with " : " + ")}: **${claim.unit === "count" ? `${value} records (${claim.currency} scope)` : formatMoney(value, claim.currency)}**.${required.length ? " " + required.map(item => qualifications[item]).join(" ") : ""}`);
      accepted.push(claim);
    } catch { removed++; }
  }
  const topics = { classification: "the unresolved classification before relying on this measure", supporting_records: "the supporting records", budget: "whether the measured activity fits your intended budget", timing: "whether timing could explain the observed pattern", recurring: "whether recurring activity merits review", goals: "whether your intended goal contributions remain suitable", assumptions: "the assumptions before making a decision" };
  for (const raw of envelope.success ? envelope.data.interpretation : []) {
    try {
      const item = interpretationSchema.parse(raw);
      const { receipt, metric } = resolve(item.reference, receipts, workspaceId);
      if (!accepted.some(claim => claim.operands.some(reference => reference.receiptId === receipt.id && reference.metricId === metric.id))) throw new Error("Interpretation lacks supported measure");
      interpretation.push(`- ${item.action === "ask" ? "You could ask about" : item.action === "consider" ? "Consider" : "Consider reviewing"} ${topics[item.topic]}, in relation to [${escapeMarkdown(metric.label)}](${financialMetricHref(receipt.id, metric.id)}). This is a possible next step, not an established cause or financial outcome.`);
    } catch { removed++; }
  }
  return {
    accepted, removed,
    body: [measured.length ? `Measured facts\n\n${measured.join("\n")}` : "No supported financial measures were available for publication.", interpretation.length ? `Interpretation — conditional next steps\n\n${interpretation.join("\n")}` : "", removed ? "Unsupported sections were removed before publication; only validated evidence is shown." : ""].filter(Boolean).join("\n\n"),
  };
}
