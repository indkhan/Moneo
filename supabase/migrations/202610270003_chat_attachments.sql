-- Photos and PDFs attached to chat messages are kept privately in the owner's workspace folder.
insert into storage.buckets (id, name, public) values ('chat', 'chat', false) on conflict (id) do update set public = false;
create policy private_chat_files on storage.objects for all to authenticated
using (bucket_id = 'chat' and exists (select 1 from public.workspaces where owner_id = (select auth.uid()) and id::text = (storage.foldername(objects.name))[1]))
with check (bucket_id = 'chat' and exists (select 1 from public.workspaces where owner_id = (select auth.uid()) and id::text = (storage.foldername(objects.name))[1]));

alter table public.messages add column attachments jsonb not null default '[]'::jsonb;
alter table public.messages add constraint messages_attachments_check check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 4);
