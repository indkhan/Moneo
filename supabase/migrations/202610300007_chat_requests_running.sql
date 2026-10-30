-- Opening a chat looks for its request still running in the background; only running rows are indexed, so the lookup stays
-- cheap however many finished requests a conversation has.
create index chat_requests_running on public.chat_requests(conversation_id, created_at desc) where status = 'running';
