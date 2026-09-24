-- Protected replay record must preserve the owner chosen during identity deletion.
ALTER TABLE deletion_tombstones ADD COLUMN successor_user_id UUID NULL;
