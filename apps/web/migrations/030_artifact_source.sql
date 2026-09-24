-- E05-S05: store immutable source on artifact versions for editor reopen/preview
-- Additive only; existing rows keep NULL source (pre-editor synthetic drafts).

ALTER TABLE artifact_versions ADD COLUMN IF NOT EXISTS source_html TEXT;
ALTER TABLE artifact_versions ADD COLUMN IF NOT EXISTS source_css TEXT;
ALTER TABLE artifact_versions ADD COLUMN IF NOT EXISTS source_js TEXT;
