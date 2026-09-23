-- Rollback E07-S03 home layouts (drops member-saved dashboard order/pins).
-- Synthetic pre-release data only. FORBIDDEN once real member layouts exist
-- without an export: disable the Home layout UI/commands first, export any
-- workspace layout a member may rely on, and never drop user layouts after
-- external use without that export. Additive migration: no other table,
-- column, or policy is touched by this rollback.

DROP TABLE IF EXISTS home_layout_tiles;
DROP TABLE IF EXISTS home_layouts;
