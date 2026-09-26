-- Close the import-review metadata gap after 012.
--
-- Accept-as-new for an ambiguous source row previously created a transaction
-- with only posted_on/description/amount/currency, leaving merchant_id and
-- category_id null even when the import mapping had explicit merchant/category
-- columns. Normal new rows (workflows/import-file.ts) populate both from the
-- explicit mapping, so review-accepted rows diverged.
--
-- This migration replaces public.resolve_import_review to also derive:
-- * category_id from the import mapping's explicit category column only.
--   Trimmed, 1..100 chars, else null (uncategorized). Never blocks accept.
-- * merchant_id from the import mapping's explicit merchant column,
--   canonicalized with the exact same table as lib/csv.ts
--   (amazon/amzn->Amazon, spotify->Spotify, netflix->Netflix, uber->Uber,
--   ikea->IKEA, substring match in the same order, else collapsed display
--   sliced to 100). Without an explicit value, the same tiny high-confidence
--   fragment table may infer from the accepted description; otherwise null.
--   Never blocks accept.
--
-- Guarantees preserved:
-- * Original description/evidence: transactions.description stays
--   btrim(p_description); source_transactions.original_row is never touched.
-- * Never overwrites a user correction: new transactions are INSERT-only;
--   merchants/categories use INSERT ... ON CONFLICT DO NOTHING (first wins,
--   same as workflow ignoreDuplicates), never UPDATE existing names.
-- * Workspace ownership: all reads/writes scoped to source_row.workspace_id
--   already checked via public.owns_workspace; new merchant/category rows use
--   the same workspace_id and are selected with workspace filters.
-- * Atomic decision: source + import rows are FOR UPDATE locked; merchant,
--   category, transaction, link, and counter updates happen in one function
--   transaction.
-- * Idempotency: same-action repeat returns the existing source row without
--   inserting a second transaction (unchanged); opposite action still errors.
-- * Exact same normalized keys where practical: merchant key is
--   lower(collapsed display) with deterministic stable uuid
--   sha256(workspace_id || ':merchant:' || normalized) formatted as in
--   workflows/import-file.ts; category key is trimmed display with stable uuid
--   sha256(workspace_id || ':category:' || display). If no explicit columns
--   or uncertainty, both stay null.
--
-- Merchants/categories remain shared reference data: never deleted by undo
-- (see 012 and 010), so no change to preview_import_undo/undo_import.

create extension if not exists pgcrypto;

-- Deterministic uuid matching workflows/import-file.ts stableId().
-- sha256 hex, then 8-4-4-4-12 with version/variant nibbles overwritten to 4/a.
create or replace function public.stable_import_uuid(p_key text)
returns uuid
language plpgsql immutable security definer set search_path = '' as $$
declare
  v_hex text;
begin
  if p_key is null then
    raise exception 'stable key required' using errcode = '22023';
  end if;
  v_hex := pg_catalog.encode(public.digest(p_key, 'sha256'), 'hex');
  return (
    pg_catalog.substr(v_hex, 1, 8) || '-' ||
    pg_catalog.substr(v_hex, 9, 4) || '-4' ||
    pg_catalog.substr(v_hex, 14, 3) || '-a' ||
    pg_catalog.substr(v_hex, 18, 3) || '-' ||
    pg_catalog.substr(v_hex, 21, 12)
  )::uuid;
end;
$$;

revoke all on function public.stable_import_uuid(text) from public;
grant execute on function public.stable_import_uuid(text) to authenticated;

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
  if p_action not in ('accept', 'reject') then
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
    select ds.account_id into account_id from public.data_sources ds
    where ds.id = import_row.source_id and ds.workspace_id = source_row.workspace_id;
    if account_id is null then
      raise exception 'Import account unavailable' using errcode = 'P0002';
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

    insert into public.transactions (workspace_id, account_id, posted_on, description, amount_minor, currency_code, merchant_id, category_id)
    values (source_row.workspace_id, account_id, p_posted_on, btrim(p_description), p_amount_minor, p_currency_code, v_merchant_id, v_category_id)
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
