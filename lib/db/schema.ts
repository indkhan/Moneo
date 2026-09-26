import { pgTable, text, numeric, timestamp, uuid, jsonb } from "drizzle-orm/pg-core";

// Canonical table definitions (Drizzle builders double as shared types; see
// drizzle-zod in lib/validations.ts). Tables live in Supabase PostgreSQL and
// are accessed at runtime through the Supabase JS client
// (lib/supabase/*, PostgREST + RLS) using only NEXT_PUBLIC_SUPABASE_URL and
// NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY — no connection string needed.

// Workspaces isolate each user's data (stack.md: RLS + workspace isolation from day one).
export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: text("owner_id").notNull(), // Supabase auth.users.id
  name: text("name").notNull().default("My finances"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Source records are preserved; imports never mutate originals.
export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  type: text("type").notNull().default("checking"), // checking | savings | investment | debt | cash | other
  balance: numeric("balance", { precision: 18, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("USD"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const transactions = pgTable("transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  accountId: uuid("account_id").references(() => accounts.id),
  date: timestamp("date").notNull(),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  category: text("category"),
  sourceRow: jsonb("source_row"), // original CSV/Excel row, preserved for evidence
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
