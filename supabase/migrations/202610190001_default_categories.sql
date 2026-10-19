-- Every workspace starts with a small category set so the Categorizer has
-- something to choose from on the first import. Signup and reset_workspace()
-- both insert into workspaces, so one trigger covers both.
create function public.default_category_names()
returns text[] language sql immutable set search_path = '' as $$
  select array['Groceries','Dining','Transport','Housing','Utilities','Shopping','Entertainment','Health','Subscriptions','Travel','Income','Fees']
$$;

create function public.seed_default_categories()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.categories(workspace_id,name) select new.id,name from unnest(public.default_category_names()) name
    on conflict(workspace_id,name) do nothing;
  return new;
end;
$$;
revoke all on function public.seed_default_categories() from public;

create trigger seed_default_categories_after_workspace
after insert on public.workspaces for each row execute function public.seed_default_categories();

-- Backfill workspaces that never got any category.
insert into public.categories(workspace_id,name)
select w.id,name from public.workspaces w cross join unnest(public.default_category_names()) name
where not exists(select 1 from public.categories c where c.workspace_id=w.id)
on conflict(workspace_id,name) do nothing;
