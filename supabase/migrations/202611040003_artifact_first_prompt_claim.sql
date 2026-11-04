-- The first request is sent once: the page that sends it claims it here first, so a reload, a second tab or
-- an old link cannot send it again. After a failed send, retrying takes a press.
alter table public.artifacts add column first_prompt_claimed_at timestamptz;
