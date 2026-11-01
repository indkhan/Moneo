-- The width the user gave each built-in Home widget ("S" to "XL"); artifact cards keep theirs on artifact_cards.size.
alter table public.dashboard_layouts add column sizes jsonb not null default '{}'::jsonb,
  add constraint dashboard_layouts_sizes_check check (jsonb_typeof(sizes) = 'object');
