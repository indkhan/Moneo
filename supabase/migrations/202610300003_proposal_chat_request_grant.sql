-- Chat cards are inserted as the signed-in user, who may only write granted columns; let them record their chat request.
grant insert (chat_request_id) on public.agent_proposals to authenticated;
