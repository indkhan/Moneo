-- A selected allocation category matches each source parent once, even when multiple children share it.
-- Money keeps the canonical amount/source; financial spending aggregates use effective_transactions instead.
create view public.transaction_category_ledger with(security_invoker=true) as
select p.id,p.workspace_id,p.account_id,p.posted_on,p.posted_at,p.description,p.amount_minor,p.currency_code,p.status,p.kind,
  categories.category_id,p.category_id as source_category_id,p.merchant_id,p.note,p.transfer_id,p.refund_of_id,p.version,p.created_at,p.tags,p.event_name,p.review_reasons
from public.transactions p join (select distinct parent_transaction_id,category_id from public.effective_transactions) categories on categories.parent_transaction_id=p.id;
grant select on public.transaction_category_ledger to authenticated,service_role;
