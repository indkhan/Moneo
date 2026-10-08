import { z } from "zod";
import { formatMoney } from "./format";

export type FinancialEvidenceReceipt = {
  id: string; workspaceId: string; fetchedAt: string; calculationVersion: string; sourceVersion: string;
  query: unknown;
  limitations?: { id: string; kind: "missing_input" | "unavailable" | "partial"; message: string; nextStep: "assumptions" | "supporting_records" }[];
  sources: { id: string; type: string; version: string; href: string }[];
  metrics: { id: string; label: string; valueMinor: string | null; currency: string; unit?: "money" | "count"; period: { from: string; to: string }; qualifiers: string[]; sourceIds: string[]; calculation: string; aggregation?: { kind: string; ids: string[]; parents: string[]; canonicalParents: string[] } }[];
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
const topicSchema = z.enum(["classification", "supporting_records", "budget", "timing", "recurring", "goals", "assumptions"]);
const nextStepSchema = z.object({
  action: z.enum(["review", "consider", "ask"]), reference: referenceSchema,
  topic: topicSchema,
}).strict();
const explanationSchema = z.object({
  action: z.literal("explain"),
  observation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("comparison"), first: referenceSchema, second: referenceSchema, relationship: z.enum(["higher", "lower", "unchanged"]) }).strict(),
    z.object({ kind: z.literal("limits"), reference: referenceSchema }).strict(),
  ]),
  hypotheses: z.array(z.enum(["timing", "one_off_activity", "recurring_activity", "classification", "missing_data", "currency_conversion", "refund_timing", "changed_allocation", "internal_funding", "planned_assumptions"])).max(4).default([]),
  uncertainty: z.literal("unproven"),
  nextSteps: z.array(topicSchema).max(4).default([]),
}).strict();
const limitationSchema = z.object({ action: z.literal("limitation"), receiptId: z.uuid(), limitationId: z.string().min(1).max(200) }).strict();
const interpretationSchema = z.union([nextStepSchema, explanationSchema, limitationSchema]);
const clarificationSchema = z.object({ topic: z.enum(["welcome", "help", "question", "period", "comparison_period", "account", "category", "merchant", "currency", "classification", "goal", "assumptions"]) }).strict();
export const financialAnswerSchema = z.object({
  claims: z.array(financialClaimSchema).max(100), interpretation: z.array(interpretationSchema).max(20),
  clarification: clarificationSchema.optional(),
}).strict();
type Claim = z.infer<typeof financialClaimSchema>;
const qualifications: Record<string, string> = {
  partial_classification: "Partial classification: unresolved rows are excluded; totals may rise or fall and are neither upper nor lower bounds.",
  partial_coverage: "Partial coverage: the records do not establish complete financial activity for this period.",
  partial_budget: "Partial budget: accepted-record spending does not establish a complete or reconciled budget remainder. Retained target, rollover, source or classification limitations require review; totals may change in either direction.",
  unresolved_included: "Unresolved classifications are included as source evidence, not confirmed spending.",
  dated_snapshot: "Dated snapshot: this measures retained evidence, not a live balance.",
  assumption: "Assumption: this projection is conditional and is not a probability or established outcome.",
  manual_evidence: "Manual evidence: a dated recorded value, not a verified current balance.",
  ambiguous_evidence: "Ambiguous balance evidence: this recorded source value does not establish an account balance. Resolve conflicting currencies, dates or source boundaries before relying on it.",
  virtual_reservation: "Virtual reservation: an earmark, not money moved or spent.",
  source_posting: "Recorded source posting: this is the canonical parent amount; effective allocations and verified fees determine financial totals. Do not add the parent to its components.",
};
export function financialQualificationText(code: string) { return qualifications[code] ?? "Evidence qualification unavailable; treat this result as uncertain."; }
function sameSet(a: string[], b: string[]) {
  const first = new Set(a), second = new Set(b);
  return a.length === first.size && b.length === second.size && a.length === b.length && a.every(value => second.has(value));
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
  const sourceCounts = new Map<string, number>();
  for (const source of receipt.sources) sourceCounts.set(source.id, (sourceCounts.get(source.id) ?? 0) + 1);
  for (const id of metric.sourceIds) if (sourceCounts.get(id) !== 1) throw new Error("Missing supporting source");
  return { receipt, metric, value: BigInt(metric.valueMinor!) };
}
export function publishFinancialClaims(input: unknown, receipts: FinancialEvidenceReceipt[], workspaceId: string) {
  const envelope = z.object({ claims: z.array(z.unknown()).max(100), interpretation: z.array(z.unknown()).max(20), clarification: z.unknown().optional() }).strict().safeParse(input);
  const accepted: Claim[] = [], measured: string[] = [], interpretation: string[] = [];
  let removed = envelope.success ? 0 : 1;
  const clarifications = {
    welcome: "Hello. What would you like to investigate? Tell me the financial question and dates you have in mind.",
    help: "I can help inspect permitted records, compare periods, explain retained financial calculations, and prepare a category-change preview. Tell me the question and scope you want to use.",
    question: "What would you like to investigate? Tell me the financial question, dates and any account or category scope.",
    period: "What start and end dates should I use for this investigation?",
    comparison_period: "Which two date ranges should I compare?",
    account: "Which owned account or accounts should I include or exclude? You can choose their names or IDs from Money.",
    category: "Which owned categories should I include or exclude?",
    merchant: "Which owned merchant or merchants should I include or exclude?",
    currency: "Which currency view should I use: separate original currencies or a chosen base currency with evidenced posting-date conversion?",
    classification: "Should I use resolved financial classifications, or show unresolved source evidence separately?",
    goal: "Which goal and dated recorded savings should I use?",
    assumptions: "Which forecast horizon, account and conditional assumptions should I evaluate?",
  };
  let clarification: string | null = null;
  if (envelope.success && envelope.data.clarification !== undefined) {
    const parsed = clarificationSchema.safeParse(envelope.data.clarification);
    if (parsed.success) clarification = clarifications[parsed.data.topic]; else removed++;
  }
  for (const raw of envelope.success ? envelope.data.claims : []) {
    try {
      const claim = financialClaimSchema.parse(raw);
      if ((claim.operation === "metric" && claim.operands.length !== 1) || (claim.operation === "difference" && claim.operands.length !== 2)) throw new Error("Invalid operands");
      const evidence = claim.operands.map(reference => resolve(reference, receipts, workspaceId));
      if (new Set(claim.operands.map(reference => JSON.stringify(reference))).size !== claim.operands.length || evidence.some(({ metric }) => (metric.unit ?? "money") !== claim.unit)) throw new Error("Duplicate operands or incompatible units");
      if (evidence.some(({ metric }) => metric.currency !== claim.currency)) throw new Error("Currency mismatch");
      if (claim.periods.length !== evidence.length || evidence.some(({ metric }, index) => JSON.stringify(metric.period) !== JSON.stringify(claim.periods[index]))) throw new Error("Period mismatch");
      if (claim.operation === "sum" && evidence.some(({ metric }) => metric.period.from !== evidence[0].metric.period.from || metric.period.to !== evidence[0].metric.period.to)) throw new Error("Sum period mismatch");
      if (claim.operation === "sum") {
        const aggregates = evidence.map(({ metric }) => metric.aggregation);
        if (aggregates.some(value => !value || value.kind !== aggregates[0]?.kind)) throw new Error("Aggregation compatibility unavailable");
        const membership = aggregates.map(value => ({ ids: new Set(value!.ids), parents: new Set(value!.parents) }));
        for (let index = 0; index < aggregates.length; index++) for (let other = index + 1; other < aggregates.length; other++) {
          const first = aggregates[index]!, second = aggregates[other]!;
          if (first.ids.some(id => membership[other].ids.has(id)) || first.canonicalParents.some(id => membership[other].parents.has(id)) || second.canonicalParents.some(id => membership[index].parents.has(id))) throw new Error("Overlapping financial contributions");
        }
      }
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
  const hypotheses = {
    timing: "Activity falling in different periods could contribute to this comparison. Check posting dates and the selected boundaries.",
    one_off_activity: "If one-off activity occurred, it could contribute to this pattern. Supporting records are needed before treating it as a cause.",
    recurring_activity: "If recurring activity changed, it could contribute to this pattern. Check actual series and occurrences before attributing the change.",
    classification: "Unresolved or corrected classifications could affect the interpretation. Check their financial kind before treating source postings as spending.",
    missing_data: "Missing or incomplete records could affect the comparison. These measures do not establish the size or direction of missing activity.",
    currency_conversion: "If these measures use currency conversion, posting-date rates or currency mix could be relevant. Check retained rate and rounding evidence before attributing the difference.",
    refund_timing: "If related refunds fell in different periods, their timing could affect net spending. Check the actual refund links and dates.",
    changed_allocation: "If category or split allocations changed, group totals could change without a corresponding change in the canonical parent amount. Check original postings and effective allocations.",
    internal_funding: "If money moved between owned accounts, funding timing could affect account-level headroom. Internal funding alone does not establish aggregate income or spending.",
    planned_assumptions: "If planned contributions or forecast assumptions changed, conditional projections could change. A projection is not evidence that the activity occurred.",
  };
  const supported = (reference: z.infer<typeof referenceSchema>) => {
    const evidence = resolve(reference, receipts, workspaceId);
    if (!accepted.some(claim => claim.operands.some(ref => ref.receiptId === evidence.receipt.id && ref.metricId === evidence.metric.id))) throw new Error("Interpretation lacks supported measure");
    return evidence;
  };
  const named = ({ receipt, metric }: ReturnType<typeof resolve>) => `[${escapeMarkdown(metric.label)} (${metric.period.from} to ${metric.period.to})](${financialMetricHref(receipt.id, metric.id)})`;
  for (const raw of envelope.success ? envelope.data.interpretation : []) {
    try {
      const item = interpretationSchema.parse(raw);
      if (item.action === "limitation") {
        const owned = receipts.filter(receipt => receipt.id === item.receiptId && receipt.workspaceId === workspaceId);
        const limits = owned.length === 1 ? owned[0].limitations?.filter(limit => limit.id === item.limitationId) : [];
        if (limits?.length !== 1) throw new Error("Retained limitation unavailable");
        const limit = limits[0];
        if (!["missing_input", "unavailable", "partial"].includes(limit.kind) || !Object.hasOwn(topics, limit.nextStep)) throw new Error("Invalid limitation");
        interpretation.push(`- Retained ${limit.kind === "missing_input" ? "missing input" : limit.kind} ([query and supporting evidence](/ai/evidence/${owned[0].id})): ${escapeMarkdown(limit.message)}. Consider reviewing ${topics[limit.nextStep]}. This limitation does not establish a financial amount or outcome.`);
      } else if (item.action === "explain") {
        let observation: string, references: string;
        if (item.observation.kind === "comparison") {
          const first = supported(item.observation.first), second = supported(item.observation.second);
          if (first.metric.currency !== second.metric.currency || (first.metric.unit ?? "money") !== (second.metric.unit ?? "money")
            || JSON.stringify(item.observation.first) === JSON.stringify(item.observation.second)) throw new Error("Incompatible explanatory comparison");
          const difference = first.value - second.value;
          if (item.observation.relationship !== (difference > 0n ? "higher" : difference < 0n ? "lower" : "unchanged")) throw new Error("Incorrect explanatory relationship");
          const magnitude = difference < 0n ? -difference : difference;
          const value = first.metric.unit === "count" ? `${magnitude} records (${first.metric.currency} scope)` : formatMoney(magnitude, first.metric.currency);
          references = `${named(first)} compared with ${named(second)}`;
          observation = difference === 0n ? `${references} has the same retained value.` : `${references} is ${value} ${item.observation.relationship}.`;
        } else {
          const evidence = supported(item.observation.reference);
          if (!evidence.metric.qualifiers.length) throw new Error("No recorded evidence limitations");
          references = named(evidence);
          observation = `Limits on ${references}: ${evidence.metric.qualifiers.map(financialQualificationText).join(" ")}`;
        }
        interpretation.push(`- ${observation} ${item.hypotheses.map(hypothesis => `Possible explanation (unproven): ${hypotheses[hypothesis]}`).join(" ")}${item.hypotheses.length ? " The retained measures do not establish these causes." : ""}${item.nextSteps.length ? ` To investigate ${references}, consider ${item.nextSteps.map(topic => topics[topic]).join("; ")}.` : ""}`);
      } else {
        const evidence = supported(item.reference);
        interpretation.push(`- ${item.action === "ask" ? "You could ask about" : item.action === "consider" ? "Consider" : "Consider reviewing"} ${topics[item.topic]}, in relation to ${named(evidence)}. This is a possible next step, not an established cause or financial outcome.`);
      }
    } catch { removed++; }
  }
  return {
    accepted, removed, clarified: clarification !== null,
    body: [measured.length ? `Measured facts\n\n${measured.join("\n")}` : clarification ?? (interpretation.length ? "" : clarifications.question), interpretation.length ? `Interpretation — conditional next steps\n\n${interpretation.join("\n")}` : "", measured.length && clarification ? clarification : "", removed ? "Unsupported sections were removed before publication; only validated evidence is shown." : ""].filter(Boolean).join("\n\n"),
  };
}
