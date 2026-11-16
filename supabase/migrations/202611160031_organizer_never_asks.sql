delete from public.organize_questions where status = 'open';

update public.agent_proposals set status = 'rejected', decided_at = now(), result = '{"organizerNoLongerAsks":true}'::jsonb
  where kind = 'organize_answer' and status in ('proposed', 'failed') and payload ? 'questionId' and payload->>'questionId' is not null;
