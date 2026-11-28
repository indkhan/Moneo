insert into storage.buckets (id, name, public) values ('logs', 'logs', false) on conflict (id) do update set public = false;
create policy private_log_audio on storage.objects for select to authenticated
using (bucket_id = 'logs' and exists (select 1 from public.workspaces where owner_id = (select auth.uid()) and id::text = (storage.foldername(objects.name))[1]));
create policy private_log_audio_delete on storage.objects for delete to authenticated
using (bucket_id = 'logs' and exists (select 1 from public.workspaces where owner_id = (select auth.uid()) and id::text = (storage.foldername(objects.name))[1]));
