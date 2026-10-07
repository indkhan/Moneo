import {z} from 'zod';

const rowSchema = z.object({id: z.uuid(), version: z.number().int().min(0).max(2147483647), description: z.string().min(1).max(1000),
  merchantId: z.uuid().nullable(), categoryId: z.uuid().nullable(), kind: z.enum(['ordinary', 'refund', 'transfer']),
  reviewReasons: z.array(z.string().max(200)).max(20), userCorrected: z.boolean()}).strict();
export const organizationRuleSchema = z.object({id: z.uuid(), version: z.number().int().min(1), descriptionKey: z.string().min(3).max(1000),
  merchantId: z.uuid().nullable(), categoryId: z.uuid().nullable(), approvedBy: z.uuid(), enabled: z.boolean()}).strict();
export type OrganizationRow = z.infer<typeof rowSchema>;
export type OrganizationRule = z.infer<typeof organizationRuleSchema>;
export type OrganizationProposal = {transactionId: string; version: number; descriptionKey: string; merchantId: string | null; categoryId: string | null;
  basis: 'approved-rule' | 'consistent-history' | 'review-required'; financialReviewRequired: boolean; evidence: {id: string; version: number}[];
  rule?: {id: string; version: number}};

export function organizationDescriptionKey(description: string) {
  return description.normalize('NFKC').toLocaleLowerCase('en').trim()
    .replace(/\b(?:ref(?:erence)?|invoice|order|receipt|terminal)\b\s*[:#-]?\s*[a-z0-9-]*\d[a-z0-9-]*\b/gu, ' ')
    .replace(/^(?:(?:card payment|pos purchase|card purchase)\s+)+/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function organizationProposals(rows: OrganizationRow[], history: OrganizationRow[], rules: OrganizationRule[]): OrganizationProposal[] {
  z.array(rowSchema).max(50).refine(values => new Set(values.map(row => row.id)).size === values.length).parse(rows);
  z.array(rowSchema).max(2000).refine(values => new Set(values.map(row => row.id)).size === values.length).parse(history);
  z.array(organizationRuleSchema).max(200).refine(values => new Set(values.filter(rule => rule.enabled).map(rule => rule.descriptionKey)).size === values.filter(rule => rule.enabled).length).parse(rules);
  const approved = new Map(rules.filter(rule => rule.enabled).map(rule => [rule.descriptionKey, rule]));
  const grouped = new Map<string, OrganizationRow[]>();
  for (const row of history) {
    const key = organizationDescriptionKey(row.description);
    if (key.length < 3 || row.kind !== 'ordinary' || row.reviewReasons.length) continue;
    const entries = grouped.get(key) ?? []; entries.push(row); grouped.set(key, entries);
  }
  const proposals: OrganizationProposal[] = [];
  for (const row of rows) {
    if (row.userCorrected || (row.merchantId && row.categoryId)) continue;
    const descriptionKey = organizationDescriptionKey(row.description), rule = approved.get(descriptionKey);
    const evidence = (grouped.get(descriptionKey) ?? []).filter(value => value.id !== row.id).sort((a, b) => a.id.localeCompare(b.id));
    const merchants = new Set(evidence.map(value => value.merchantId));
    const categories = new Set(evidence.map(value => value.categoryId));
    const merchantId = evidence.length >= 3 && merchants.size === 1 ? evidence[0].merchantId : null;
    const categoryId = evidence.length >= 3 && categories.size === 1 ? evidence[0].categoryId : null;
    proposals.push({transactionId: row.id, version: row.version, descriptionKey,
      merchantId: row.merchantId ?? rule?.merchantId ?? merchantId, categoryId: row.categoryId ?? rule?.categoryId ?? categoryId,
      basis: rule ? 'approved-rule' : merchantId && categoryId ? 'consistent-history' : 'review-required',
      financialReviewRequired: row.reviewReasons.length > 0 || row.kind === 'transfer',
      evidence: evidence.map(value => ({id: value.id, version: value.version})), ...(rule ? {rule: {id: rule.id, version: rule.version}} : {})});
  }
  return proposals.sort((a, b) => Number(b.financialReviewRequired) - Number(a.financialReviewRequired) || a.transactionId.localeCompare(b.transactionId));
}
