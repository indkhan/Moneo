-- A tenant-owned attempt must reference a job in the same workspace.
-- The old single-column FK only proved that the job existed, which allowed
-- an owner/admin write to create an internally inconsistent cross-tenant row.
ALTER TABLE background_jobs
  ADD CONSTRAINT background_jobs_workspace_id_id_uniq UNIQUE (workspace_id, id);
--> statement-breakpoint
ALTER TABLE background_job_attempts
  ADD CONSTRAINT background_job_attempts_workspace_job_fk
  FOREIGN KEY (workspace_id, job_id)
  REFERENCES background_jobs (workspace_id, id)
  ON DELETE CASCADE;
