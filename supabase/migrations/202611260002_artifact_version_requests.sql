alter table public.artifact_versions add column request_id uuid references public.chat_requests(id) on delete set null;
alter table public.artifact_card_versions add column request_id uuid references public.chat_requests(id) on delete set null;
create index artifact_versions_request on public.artifact_versions (request_id) where request_id is not null;
create index artifact_card_versions_request on public.artifact_card_versions (request_id) where request_id is not null;
