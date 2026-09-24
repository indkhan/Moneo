-- E03-S02 rollback: drop calculation_versions table.
-- Only safe before any real calculation history exists.

DROP POLICY IF EXISTS calculation_versions_isolation ON calculation_versions;
DROP TABLE IF EXISTS calculation_versions;