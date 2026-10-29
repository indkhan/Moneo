-- Links a chat card to the chat request that made it, so a voice-call correction can dismiss the cards of the request it replaces.
alter table public.agent_proposals add column chat_request_id uuid references public.chat_requests(id) on delete set null;
create index agent_proposals_chat_request on public.agent_proposals(chat_request_id) where chat_request_id is not null;
