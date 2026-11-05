-- Keep saved HTML history, but new Pages use the same isolated code-to-tree boundary as Home cards.
alter table public.artifact_versions alter column html drop not null;
alter table public.artifact_versions add column source text,
  add column compiled text,
  add column params jsonb not null default '[]'::jsonb;
alter table public.artifact_versions add constraint artifact_versions_rendering_check check (
  (html is not null and source is null and compiled is null)
  or (html is null and length(source) between 1 and 200000 and length(compiled) between 1 and 400000
    and source is not null and compiled is not null)
), add constraint artifact_versions_params_check check (jsonb_typeof(params) = 'array');
