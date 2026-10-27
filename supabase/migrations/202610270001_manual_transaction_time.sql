-- A manual entry dated today records when it was entered, so it moves a balance observed earlier that day.
create or replace function public.create_manual_transaction(p_account_id uuid,p_posted_on date,p_description text,p_amount_minor text,p_status text,p_category_id uuid,p_note text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account public.accounts%rowtype;
  transaction public.transactions%rowtype;
  entry public.manual_transaction_entries%rowtype;
  original jsonb;
  timezone text;
  observation timestamptz:=date_trunc('milliseconds',clock_timestamp());
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_posted_on is null or p_description is null or length(btrim(p_description)) not between 1 and 500 or p_note is null or length(p_note)>2000
    or p_amount_minor is null or p_amount_minor !~ '^-?[0-9]+$' or length(p_amount_minor)>20 or p_status is null or p_status not in('posted','pending') or p_request_id is null
    then raise exception 'Invalid manual transaction' using errcode = '22023'; end if;
  select * into account from public.accounts where id=p_account_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Account not found' using errcode = 'P0002'; end if;
  if p_category_id is not null and not exists(select 1 from public.categories where id=p_category_id and workspace_id=account.workspace_id)
    then raise exception 'Category not found' using errcode = 'P0002'; end if;
  original := jsonb_build_object('account_id',p_account_id,'posted_on',p_posted_on,'description',btrim(p_description),'amount_minor',(p_amount_minor::bigint)::text,
    'currency_code',account.currency_code,'status',p_status,'kind','ordinary','category_id',p_category_id,'note',p_note);
  select * into entry from public.manual_transaction_entries where workspace_id=account.workspace_id and request_id=p_request_id;
  if found then
    if not entry.original_record @> original then raise exception 'Request ID reused for another transaction' using errcode = '22023'; end if;
    return jsonb_build_object('id',entry.transaction_id,'entryId',entry.id,'undone',entry.undone_at is not null);
  end if;
  select coalesce((select s.timezone from public.workspace_settings s where workspace_id=account.workspace_id),'Europe/Berlin') into timezone;
  insert into public.transactions(workspace_id,account_id,posted_on,posted_at,description,amount_minor,currency_code,status,kind,category_id,note)
    values(account.workspace_id,p_account_id,p_posted_on,case when p_posted_on=(observation at time zone timezone)::date then observation end,
      btrim(p_description),p_amount_minor::bigint,account.currency_code,p_status,'ordinary',p_category_id,p_note)
    returning * into transaction;
  original := to_jsonb(transaction)||jsonb_build_object('amount_minor',transaction.amount_minor::text);
  insert into public.manual_transaction_entries(workspace_id,transaction_id,request_id,actor_id,original_record)
    values(account.workspace_id,transaction.id,p_request_id,auth.uid(),original) returning * into entry;
  return jsonb_build_object('id',transaction.id,'entryId',entry.id,'undone',false);
end;
$$;
