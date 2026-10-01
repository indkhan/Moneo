-- Preserve reviewed product/account/currency routing and posting status on overlap acceptance.
-- Existing metadata, atomic counters, ownership checks, and idempotency are retained.

create or replace function public.resolve_import_review(
  p_source_id uuid,
  p_action text,
  p_posted_on date default null,
  p_description text default null,
  p_amount_minor bigint default null,
  p_currency_code text default null
) returns public.source_transactions
language plpgsql security definer set search_path = '' as $$
declare
  source_row public.source_transactions%rowtype;
  import_row public.imports%rowtype;
  account_id uuid;
  v_account_name text;
  v_route jsonb;
  v_route_count integer := 0;
  v_status text := 'posted';
  v_currency text;
  transaction_id uuid;
  v_merchant_id uuid := null;
  v_category_id uuid := null;
  v_merchant_col text;
  v_category_col text;
  v_raw_merchant text;
  v_raw_category text;
  v_cleaned text;
  v_display text;
  v_lower text;
  v_desc_lower text;
  v_normalized text;
  v_key text;
  v_existing_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_action is null or p_action not in ('accept', 'reject') then
    raise exception 'Invalid review action' using errcode = '22023';
  end if;
  select * into source_row from public.source_transactions
  where id = p_source_id and public.owns_workspace(workspace_id) for update;
  if not found then
    raise exception 'Review row not found' using errcode = 'P0002';
  end if;
  if source_row.status in ('accepted', 'rejected') then
    if (p_action = 'accept' and source_row.status = 'accepted') or
       (p_action = 'reject' and source_row.status = 'rejected') then
      return source_row;
    end if;
    raise exception 'Review row already resolved' using errcode = '40001';
  end if;
  if source_row.status <> 'review' then
    raise exception 'Row is not awaiting review' using errcode = '40001';
  end if;
  select * into import_row from public.imports
  where id = source_row.import_id and workspace_id = source_row.workspace_id for update;
  if import_row.status <> 'completed' then
    raise exception 'Import is still processing' using errcode = '40001';
  end if;
  if import_row.review_rows < 1 then
    raise exception 'Import review count is inconsistent' using errcode = '40001';
  end if;
  if p_action = 'accept' then
    if p_posted_on is null or nullif(btrim(p_description), '') is null or
       length(p_description) > 500 or p_amount_minor is null or
       p_currency_code is null or p_currency_code !~ '^[A-Z]{3}$' then
      raise exception 'Invalid transaction values' using errcode = '22023';
    end if;
    -- Derive the reviewed destination from preserved evidence, never a caller's account ID.
    v_currency := upper(btrim(case when nullif(import_row.mapping ->> 'currencyColumn', '') is not null
      then source_row.original_row ->> (import_row.mapping ->> 'currencyColumn')
      else import_row.mapping ->> 'currencyCode' end));
    if v_currency is distinct from p_currency_code then
      raise exception 'Currency must match reviewed source evidence' using errcode = '22023';
    end if;
    v_account_name := import_row.mapping ->> 'accountName';
    if nullif(import_row.mapping ->> 'accountColumn', '') is not null or
       nullif(import_row.mapping ->> 'productColumn', '') is not null or
       import_row.mapping ? 'accountRoutes' then
      for v_route in select value from jsonb_array_elements(coalesce(import_row.mapping -> 'accountRoutes', '[]'::jsonb)) loop
        if v_route ->> 'currencyCode' = p_currency_code and
           (case when nullif(import_row.mapping ->> 'accountColumn', '') is null then not (v_route ? 'accountValue')
             else v_route ->> 'accountValue' = btrim(source_row.original_row ->> (import_row.mapping ->> 'accountColumn')) end) and
           (case when nullif(import_row.mapping ->> 'productColumn', '') is null then not (v_route ? 'productValue')
             else v_route ->> 'productValue' = btrim(source_row.original_row ->> (import_row.mapping ->> 'productColumn')) end) then
          v_route_count := v_route_count + 1;
          v_account_name := v_route ->> 'accountName';
        end if;
      end loop;
      if v_route_count <> 1 then
        raise exception 'Exactly one reviewed account route is required' using errcode = '22023';
      end if;
    end if;
    select a.id into account_id from public.accounts a
    where a.workspace_id = source_row.workspace_id and a.name = v_account_name and a.currency_code = p_currency_code;
    if account_id is null then
      raise exception 'Reviewed import account unavailable' using errcode = 'P0002';
    end if;
    if (select count(*) from public.accounts a where a.workspace_id = source_row.workspace_id and a.name = v_account_name and a.currency_code = p_currency_code) <> 1 then
      raise exception 'Reviewed import account is ambiguous' using errcode = '22023';
    end if;
    if nullif(import_row.mapping ->> 'statusColumn', '') is not null then
      v_status := lower(btrim(source_row.original_row ->> (import_row.mapping ->> 'statusColumn')));
      if v_status in ('completed', 'posted', '') then v_status := 'posted';
      elsif v_status = 'pending' then v_status := 'pending';
      else raise exception 'Unsupported source status requires mapping review' using errcode = '22023';
      end if;
    end if;

    -- Best-effort metadata: explicit mapping columns only; any uncertainty
    -- leaves null and never blocks the accept. Never updates existing rows.
    v_merchant_col := import_row.mapping ->> 'merchantColumn';
    if nullif(btrim(v_merchant_col), '') is null then
      v_merchant_col := null;
    end if;
    v_category_col := import_row.mapping ->> 'categoryColumn';
    if nullif(btrim(v_category_col), '') is null then
      v_category_col := null;
    end if;

    if v_category_col is not null then
      begin
        v_raw_category := source_row.original_row ->> v_category_col;
        v_display := nullif(btrim(v_raw_category), '');
        if v_display is not null and char_length(v_display) between 1 and 100 then
          select id into v_existing_id from public.categories
          where workspace_id = source_row.workspace_id and name = v_display;
          if v_existing_id is null then
            v_key := source_row.workspace_id::text || ':category:' || v_display;
            begin
              insert into public.categories (id, workspace_id, name)
              values (public.stable_import_uuid(v_key), source_row.workspace_id, v_display)
              on conflict do nothing;
            exception when others then
              -- concurrent insert won; fall through to select below
            end;
            select id into v_existing_id from public.categories
            where workspace_id = source_row.workspace_id and name = v_display;
          end if;
          v_category_id := v_existing_id;
        end if;
      exception when others then
        v_category_id := null;
      end;
    end if;

    begin
      v_display := null;
      if v_merchant_col is not null then
        v_raw_merchant := source_row.original_row ->> v_merchant_col;
        v_cleaned := nullif(pg_catalog.regexp_replace(btrim(v_raw_merchant), '\s+', ' ', 'g'), '');
        if v_cleaned is not null then
          v_cleaned := pg_catalog.substring(v_cleaned, 1, 100);
          v_lower := pg_catalog.lower(v_cleaned);
          if v_lower = 'amazon' or v_lower = 'amzn' then
            v_display := 'Amazon';
          elsif v_lower = 'spotify' then
            v_display := 'Spotify';
          elsif v_lower = 'netflix' then
            v_display := 'Netflix';
          elsif v_lower = 'uber' then
            v_display := 'Uber';
          elsif v_lower = 'ikea' then
            v_display := 'IKEA';
          elsif v_lower like '%amazon%' then
            v_display := 'Amazon';
          elsif v_lower like '%amzn%' then
            v_display := 'Amazon';
          elsif v_lower like '%spotify%' then
            v_display := 'Spotify';
          elsif v_lower like '%netflix%' then
            v_display := 'Netflix';
          elsif v_lower like '%uber%' then
            v_display := 'Uber';
          elsif v_lower like '%ikea%' then
            v_display := 'IKEA';
          else
            v_display := v_cleaned;
          end if;
        end if;
      end if;

      if v_display is null then
        v_desc_lower := pg_catalog.lower(btrim(p_description));
        if v_desc_lower like '%amazon%' then
          v_display := 'Amazon';
        elsif v_desc_lower like '%amzn%' then
          v_display := 'Amazon';
        elsif v_desc_lower like '%spotify%' then
          v_display := 'Spotify';
        elsif v_desc_lower like '%netflix%' then
          v_display := 'Netflix';
        elsif v_desc_lower like '%uber%' then
          v_display := 'Uber';
        elsif v_desc_lower like '%ikea%' then
          v_display := 'IKEA';
        else
          v_display := null;
        end if;
      end if;

      if v_display is not null and char_length(v_display) between 1 and 100 then
        v_normalized := pg_catalog.lower(v_display);
        if char_length(v_normalized) between 1 and 100 then
          select id into v_existing_id from public.merchants
          where workspace_id = source_row.workspace_id and normalized_name = v_normalized;
          if v_existing_id is null then
            v_key := source_row.workspace_id::text || ':merchant:' || v_normalized;
            begin
              insert into public.merchants (id, workspace_id, name, normalized_name)
              values (public.stable_import_uuid(v_key), source_row.workspace_id, v_display, v_normalized)
              on conflict do nothing;
            exception when others then
              -- concurrent insert won; fall through to select below
            end;
            select id into v_existing_id from public.merchants
            where workspace_id = source_row.workspace_id and normalized_name = v_normalized;
          end if;
          v_merchant_id := v_existing_id;
        end if;
      end if;
    exception when others then
      v_merchant_id := null;
    end;

    insert into public.transactions (workspace_id, account_id, posted_on, description, amount_minor, currency_code, merchant_id, category_id, status)
    values (source_row.workspace_id, account_id, p_posted_on, btrim(p_description), p_amount_minor, p_currency_code, v_merchant_id, v_category_id, v_status)
    returning id into transaction_id;
    insert into public.transaction_sources (transaction_id, source_transaction_id)
    values (transaction_id, source_row.id);
    update public.imports set new_rows = new_rows + 1, review_rows = review_rows - 1
    where id = import_row.id;
    update public.source_transactions set status = 'accepted' where id = source_row.id returning * into source_row;
  else
    update public.imports set review_rows = review_rows - 1, rejected_rows = rejected_rows + 1
    where id = import_row.id;
    update public.source_transactions set status = 'rejected' where id = source_row.id returning * into source_row;
  end if;
  return source_row;
end;
$$;

revoke all on function public.resolve_import_review(uuid, text, date, text, bigint, text) from public;
grant execute on function public.resolve_import_review(uuid, text, date, text, bigint, text) to authenticated;
