-- A chat starts with a stand-in title (its first words, or "Voice call") until Moneo writes a short one.
-- Settled means leave it alone: Moneo wrote it, or the owner renamed it or asked for a new one.
alter table public.conversations add column title_settled boolean not null default false;

-- A title that is not still the chat's first words was chosen by the owner, or belongs to an artifact.
update public.conversations c set title_settled = true
where c.artifact_id is not null
  or not (
    coalesce(left((select m.content from public.messages m where m.conversation_id = c.id and m.role = 'user' order by m.created_at, m.id limit 1), 80), '') = c.title
    or exists (select 1 from public.voice_calls v, jsonb_array_elements(v.transcript) turn where v.conversation_id = c.id and left(turn->>'text', 80) = c.title)
  );

create index conversations_title_unsettled on public.conversations(created_at desc) where not title_settled and deleted_at is null and artifact_id is null;
grant update (title_settled) on public.conversations to authenticated;
