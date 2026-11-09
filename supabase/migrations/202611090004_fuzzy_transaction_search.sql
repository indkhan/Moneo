-- Chat searches transactions by the names people use, which are often short forms or typos of the
-- bank text ("Venji" for "Venjalin Ravindran"). Trigram word similarity finds those. The caller's date
-- and absolute-amount filters apply before the limit, so stronger matches elsewhere can't crowd out
-- the right row; row-level security limits rows to the owner's workspace.
create extension if not exists pg_trgm schema extensions;

create or replace function public.similar_transaction_ids(p_workspace_id uuid, p_query text, p_from date default null, p_to date default null,
  p_min_minor bigint default null, p_max_minor bigint default null, p_limit integer default 50)
returns table (id uuid) language sql stable security invoker set search_path = '' as $$
  select t.id from public.transactions t
  where t.workspace_id = p_workspace_id
    and (p_from is null or t.posted_on >= p_from) and (p_to is null or t.posted_on <= p_to)
    and (p_min_minor is null or abs(t.amount_minor) >= p_min_minor) and (p_max_minor is null or abs(t.amount_minor) <= p_max_minor)
    and extensions.word_similarity(p_query, t.description) >= 0.5
  order by extensions.word_similarity(p_query, t.description) desc, t.posted_on desc, t.id
  limit least(greatest(p_limit, 1), 200)
$$;

revoke all on function public.similar_transaction_ids(uuid, text, date, date, bigint, bigint, integer) from public, anon;
grant execute on function public.similar_transaction_ids(uuid, text, date, date, bigint, bigint, integer) to authenticated, service_role;
