do $$
declare definition text;
  slow_guard constant text:='    if not p_review and not coalesce((p_row->>''byOccurrence'')::boolean,false) and exists(select 1 from public.transactions t where t.workspace_id=p_workspace_id and t.account_id=p_account_id and t.currency_code=p_row->>''currencyCode'' and t.id<>canonical_id and
      not exists(select 1 from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id where l.transaction_id=t.id and s.import_id=p_import_id) and
      ((t.posted_on=(p_row->>''postedOn'')::date and t.amount_minor=(p_row->>''amountMinor'')::bigint and t.description=p_row->>''description'') or
      (p_row->>''externalId'' is not null and exists(select 1 from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id where l.transaction_id=t.id and s.external_id=p_row->>''externalId'')))) then';
  indexed_guard constant text:='    if not p_review and not coalesce((p_row->>''byOccurrence'')::boolean,false) and (exists(select 1 from public.transactions t where t.workspace_id=p_workspace_id and t.account_id=p_account_id and t.currency_code=p_row->>''currencyCode'' and t.id<>canonical_id and
      t.posted_on=(p_row->>''postedOn'')::date and t.amount_minor=(p_row->>''amountMinor'')::bigint and t.description=p_row->>''description'' and
      not exists(select 1 from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id where l.transaction_id=t.id and s.import_id=p_import_id)) or
      (p_row->>''externalId'' is not null and exists(select 1 from public.source_transactions e join public.transaction_sources el on el.source_transaction_id=e.id join public.transactions t on t.id=el.transaction_id
        where e.external_id=p_row->>''externalId'' and t.workspace_id=p_workspace_id and t.account_id=p_account_id and t.currency_code=p_row->>''currencyCode'' and t.id<>canonical_id and
        not exists(select 1 from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id where l.transaction_id=t.id and s.import_id=p_import_id)))) then';
begin
  definition:=pg_get_functiondef('public.ingest_import_row_internal(uuid,uuid,integer,uuid,jsonb,boolean)'::regprocedure);
  if position(slow_guard in definition)=0 then raise exception 'Expected import candidate guard absent'; end if;
  execute replace(definition,slow_guard,indexed_guard);
end;
$$;
