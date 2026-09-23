-- Rollback E07-S04 notices (drops member-visible job completion/failure
-- notices). Synthetic pre-release data only. FORBIDDEN once real member
-- notices exist without an export: disable the notices UI/producer first,
-- export any workspace notices a member may rely on, and never drop accepted
-- notices after external use without that export. Additive migration: no
-- other table, column, or policy is touched by this rollback.

DROP TABLE IF EXISTS notices;
