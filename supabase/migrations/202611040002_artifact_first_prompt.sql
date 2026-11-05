-- The request typed when an artifact was created. It used to travel in the page URL, where any link could send
-- a paid prompt. The page sends this once, and only while the artifact's chat is still empty.
alter table public.artifacts add column first_prompt text,
  add constraint artifacts_first_prompt_check check (length(first_prompt) <= 4000);
