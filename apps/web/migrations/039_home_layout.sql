-- E07-S03: pin and arrange persistent artifacts on the one Home dashboard.
-- One layout row per workspace (optimistic BIGINT version, CAS-guarded;
-- versions cross JSON strictly as decimal strings) plus pinned artifact
-- refs in home_layout_tiles. Composite tenant keys and composite FKs keep
-- every pin inside its own workspace; FORCE RLS with the NULLIF guard
-- (033 precedent) fails closed to zero rows under empty context.
-- user_edited marks any member change so analysis personalization must
-- never overwrite the saved order. Additive only; rollback drops these two
-- pre-history tables only and is forbidden once member layouts exist in
-- real use without an export (see rollback file).

CREATE TABLE IF NOT EXISTS home_layouts (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  version BIGINT NOT NULL DEFAULT 1 CONSTRAINT home_layouts_version_min CHECK (version >= 1),
  user_edited BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id)
);

ALTER TABLE home_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE home_layouts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON home_layouts;
CREATE POLICY workspace_isolation ON home_layouts
    USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
    WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

CREATE TABLE IF NOT EXISTS home_layout_tiles (
  workspace_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  position INTEGER NOT NULL CONSTRAINT home_layout_tiles_position_min CHECK (position >= 0),
  size TEXT NOT NULL CONSTRAINT home_layout_tiles_size CHECK (size IN ('small', 'wide', 'large')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES home_layouts (workspace_id) ON DELETE CASCADE
);

ALTER TABLE home_layout_tiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE home_layout_tiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON home_layout_tiles;
CREATE POLICY workspace_isolation ON home_layout_tiles
    USING (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid)
    WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace', true), '')::uuid);

CREATE INDEX IF NOT EXISTS home_layout_tiles_order_idx ON home_layout_tiles (workspace_id, position);
