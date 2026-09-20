-- E05-S05 rollback: drop source columns (synthetic pre-release data only).
ALTER TABLE artifact_versions DROP COLUMN IF EXISTS source_js;
ALTER TABLE artifact_versions DROP COLUMN IF EXISTS source_css;
ALTER TABLE artifact_versions DROP COLUMN IF EXISTS source_html;
