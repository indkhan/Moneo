-- The chat requests a call started, so the chat can find and group their messages under the call.
alter table public.voice_calls add column request_ids uuid[] not null default '{}' check (cardinality(request_ids) <= 30);
create index voice_calls_request_ids on public.voice_calls using gin (request_ids);
grant insert (request_ids) on public.voice_calls to authenticated;
