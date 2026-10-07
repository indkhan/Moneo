-- Trusted server calculations create immutable query receipts. Owners can read,
-- but cannot forge receipts by inserting or editing a JSON payload from the client.
create table public.financial_evidence_receipts (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  scopes text[] not null,
  receipt jsonb not null,
  created_at timestamptz not null default now(),
  constraint financial_evidence_receipts_scopes_check check (cardinality(scopes) between 0 and 4 and scopes <@ array['accounts','transactions','planning','imports']::text[]),
  constraint financial_evidence_receipts_payload_check check (jsonb_typeof(receipt) = 'object' and octet_length(receipt::text) <= 16777216
    and receipt->>'id' = id::text and receipt->>'workspaceId' = workspace_id::text
    and jsonb_typeof(receipt->'query') = 'object' and jsonb_typeof(receipt->'metrics') = 'array'
    and jsonb_typeof(receipt->'sources') = 'array' and receipt->'scopes' = to_jsonb(scopes))
);
create index financial_evidence_receipts_workspace_created on public.financial_evidence_receipts(workspace_id,created_at);
alter table public.financial_evidence_receipts enable row level security;
revoke all on public.financial_evidence_receipts from public,anon,authenticated;
grant select on public.financial_evidence_receipts to authenticated;
grant select,insert,delete on public.financial_evidence_receipts to service_role;
create policy financial_evidence_receipts_owner_read on public.financial_evidence_receipts for select to authenticated
  using (public.owns_workspace(workspace_id) and scopes <@ coalesce((select settings.ai_data_scopes from public.workspace_settings settings where settings.workspace_id=financial_evidence_receipts.workspace_id),array['accounts','transactions','planning','imports']::text[]));
create function public.prevent_financial_evidence_update() returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'Financial evidence receipts are immutable' using errcode='55000';
end;
$$;
revoke all on function public.prevent_financial_evidence_update() from public,anon,authenticated;
create trigger financial_evidence_receipts_immutable before update on public.financial_evidence_receipts
  for each row execute function public.prevent_financial_evidence_update();
