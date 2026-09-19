-- E03-S05 rollback: categories, tags, transaction_tags, category_id, version
-- Drop code first (commands/routes), then schema. Forbidden after real corrections exist.

ALTER TABLE manual_transactions DROP CONSTRAINT IF EXISTS manual_transactions_category_fk;
ALTER TABLE manual_transactions DROP COLUMN IF EXISTS category_id;
ALTER TABLE manual_transactions DROP COLUMN IF EXISTS version;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_category_fk;
DROP INDEX IF EXISTS transactions_category_idx;
ALTER TABLE transactions DROP COLUMN IF EXISTS category_id;
ALTER TABLE transactions DROP COLUMN IF EXISTS version;

DROP TABLE IF EXISTS transaction_tags;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS system_categories;