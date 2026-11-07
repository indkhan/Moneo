-- The owner's own service keys (OpenAI, OpenRouter, Enable Banking), entered in the app instead of .env.
-- One set per installation, like the ChatGPT sign-in, so rows are not tied to a workspace and a
-- workspace reset keeps them. Values are AES-256-GCM sealed and readable by service_role only.
create table public.service_keys (
  name text primary key check (name in ('openai_api_key','openrouter_api_key','enable_banking_app_id','enable_banking_private_key')),
  value_encrypted text not null check (char_length(value_encrypted) between 1 and 20000),
  updated_at timestamptz not null default now()
);
alter table public.service_keys enable row level security;
revoke all on public.service_keys from anon, authenticated;
grant all on public.service_keys to service_role;
