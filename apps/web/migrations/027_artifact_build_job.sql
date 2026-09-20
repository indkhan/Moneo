-- E05-S01: Add artifact.build job type to background_jobs check constraint
-- This extends the E02-S01 job system with artifact build capability

-- Add artifact.build to the allowed job types (extending, never narrowing:
-- chat.generate from E04-S02 must remain allowed).
ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_type;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_type CHECK (job_type IN ('imports.start', 'chat.generate', 'artifact.build'));

-- Add artifact_build result kind to background_job_results
ALTER TABLE background_job_results DROP CONSTRAINT IF EXISTS background_job_results_kind;
ALTER TABLE background_job_results ADD CONSTRAINT background_job_results_kind CHECK (result_kind IN ('synthetic-noop', 'artifact_build'));