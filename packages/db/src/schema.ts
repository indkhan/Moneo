import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * ISO 4217 currency metadata. Minor-unit exponent is authoritative for all
 * money arithmetic (see @moneo/shared money utils). Amounts themselves are
 * always stored as integer minor units alongside a currency code.
 */
export const currencies = pgTable("currencies", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  minorDigits: integer("minor_digits").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Currency = typeof currencies.$inferSelect;
export type NewCurrency = typeof currencies.$inferInsert;
