-- A card's title belongs to each version, so renaming it in a draft doesn't change what Home shows until it is published.
alter table public.artifact_card_versions add column title text;
update public.artifact_card_versions v set title = c.title from public.artifact_cards c where c.id = v.card_id;
alter table public.artifact_card_versions alter column title set not null,
  add constraint artifact_card_versions_title_check check (length(btrim(title)) between 1 and 80);
