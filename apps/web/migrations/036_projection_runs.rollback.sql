-- E06-S03 rollback: projection runs, points, events (synthetic only).
-- Drop code first, then schema. Forbidden after real projections exist.

DROP TABLE IF EXISTS projection_events;
DROP TABLE IF EXISTS projection_points;
DROP TABLE IF EXISTS projection_runs;