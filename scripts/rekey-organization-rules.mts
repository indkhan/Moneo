/**
 * One-off: rules saved before keys dropped dates and reference numbers match nothing any more. Each such rule is
 * turned off (kept, not deleted) and its choice carried to the clean key its transactions now share, unless another
 * rule already decides that key differently. Dry run by default:
 *   npx tsx --env-file=.env scripts/rekey-organization-rules.mts [--apply]
 */
import postgres from 'postgres';
import {organizationDescriptionKey} from '../lib/import/organization.ts';

// The key as it was before 64fb8b30, to find each old rule's transactions.
const oldKey = (description: string) => description.normalize('NFKC').toLocaleLowerCase('en').trim()
  .replace(/\b(?:ref(?:erence)?|invoice|order|receipt|terminal)\b\s*[:#-]?\s*[a-z0-9-]*\d[a-z0-9-]*\b/gu, ' ')
  .replace(/^(?:(?:card payment|pos purchase|card purchase)\s+)+/u, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

type Rule = {id: string; workspace_id: string; description_key: string; merchant_id: string | null; category_id: string | null; approved_by: string; enabled: boolean};
const apply = process.argv.includes('--apply');
const sql = postgres(process.env.SUPABASE_DB_URL!, {prepare: false, max: 1});

await sql.begin(async tx => {
  const rules = await tx<Rule[]>`select id, workspace_id, description_key, merchant_id, category_id, approved_by, enabled from public.organization_rules order by workspace_id for update`;
  const workspaces = [...new Set(rules.map(rule => rule.workspace_id))];
  let off = 0, carried = 0, skipped = 0;
  for (const workspace of workspaces) {
    const descriptions = await tx<{description: string}[]>`select description from public.transactions where workspace_id = ${workspace} and status <> 'voided'`;
    const live = new Set(descriptions.map(row => organizationDescriptionKey(row.description)));
    const owned = rules.filter(rule => rule.workspace_id === workspace);
    const byKey = new Map(owned.map(rule => [rule.description_key, rule]));
    const dead = owned.filter(rule => rule.enabled && !live.has(rule.description_key));
    // Where each dead rule's transactions now land; several old rules can land on one clean key.
    const targets = new Map<string, Rule[]>();
    for (const rule of dead) {
      const keys = new Set(descriptions.filter(row => oldKey(row.description) === rule.description_key).map(row => organizationDescriptionKey(row.description)));
      const key = keys.size === 1 ? [...keys][0] : null;
      if (key && key.length >= 3) targets.set(key, [...targets.get(key) ?? [], rule]);
    }
    for (const rule of dead) {
      if (apply) await tx`update public.organization_rules set enabled = false, version = version + 1, updated_at = now() where id = ${rule.id}`;
      off++;
    }
    for (const [key, sources] of targets) {
      const choice = (rule: Rule) => `${rule.merchant_id}:${rule.category_id}`;
      const existing = byKey.get(key);
      if (new Set(sources.map(choice)).size > 1 || (existing?.enabled && choice(existing) !== choice(sources[0]))) { skipped++; console.log('ambiguous, left off:', key); continue; }
      if (existing?.enabled) continue;
      const {merchant_id, category_id, approved_by} = sources.at(-1)!;
      if (apply) await tx`insert into public.organization_rules (workspace_id, description_key, merchant_id, category_id, approved_by, enabled)
        values (${workspace}, ${key}, ${merchant_id}, ${category_id}, ${approved_by}, true)
        on conflict (workspace_id, description_key) do update set merchant_id = excluded.merchant_id, category_id = excluded.category_id,
          approved_by = excluded.approved_by, enabled = true, version = public.organization_rules.version + 1, updated_at = now()`;
      carried++;
    }
  }
  console.log(`${apply ? 'Applied' : 'Dry run'}: ${off} rules turned off, ${carried} carried to a clean key, ${skipped} ambiguous left off`);
});
await sql.end();
