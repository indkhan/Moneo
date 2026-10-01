import { sql } from "drizzle-orm";
import { pgTable, pgSchema, uuid, text, timestamp, date, bigint, integer, jsonb, boolean, uniqueIndex, unique, index, check, foreignKey, primaryKey, type AnyPgColumn } from "drizzle-orm/pg-core";

// Supabase owns the rest of auth.users; only its referenced primary key belongs here.
const authUsers = pgSchema("auth").table("users", { id: uuid("id").primaryKey() });

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().unique().references(() => authUsers.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("My finances"),
  displayCurrency: text("display_currency").notNull().default("EUR"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  type: text("type").notNull().default("checking"),
  currencyCode: text("currency_code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const balanceSnapshots = pgTable("balance_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  provenance: text("provenance").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const dataSources = pgTable("data_sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  accountId: uuid("account_id").references(() => accounts.id),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const imports = pgTable("imports", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  sourceId: uuid("source_id").references(() => dataSources.id),
  filename: text("filename").notNull(),
  storagePath: text("storage_path").notNull(),
  fileHash: text("file_hash").notNull(),
  status: text("status").notNull().default("pending"),
  mapping: jsonb("mapping"),
  totalRows: integer("total_rows").notNull().default(0),
  newRows: integer("new_rows").notNull().default(0),
  matchedRows: integer("matched_rows").notNull().default(0),
  reviewRows: integer("review_rows").notNull().default(0),
  rejectedRows: integer("rejected_rows").notNull().default(0),
  error: text("error"),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoneBy: uuid("undone_by").references(() => authUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [unique("imports_workspace_hash_unique").on(table.workspaceId, table.fileHash)]);

export const sourceTransactions = pgTable("source_transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  importId: uuid("import_id").notNull().references(() => imports.id),
  rowNumber: integer("row_number").notNull(),
  originalRow: jsonb("original_row").notNull(),
  externalId: text("external_id"),
  status: text("status").notNull().default("new"),
}, (table) => [unique("source_transactions_import_row_unique").on(table.importId, table.rowNumber)]);

export const categories = pgTable("categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
}, (table) => [unique("categories_workspace_name_unique").on(table.workspaceId, table.name)]);

export const merchants = pgTable("merchants", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("merchants_workspace_normalized_unique").on(table.workspaceId, table.normalizedName),
  index("merchants_workspace_normalized_idx").on(table.workspaceId, table.normalizedName),
  check("merchants_name_check", sql`char_length(${table.name}) between 1 and 100`),
  check("merchants_normalized_name_check", sql`char_length(${table.normalizedName}) between 1 and 100`),
]);

export const transactions = pgTable("transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  postedOn: date("posted_on").notNull(),
  description: text("description").notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  status: text("status").notNull().default("posted"),
  kind: text("kind").notNull().default("ordinary"),
  categoryId: uuid("category_id").references(() => categories.id),
  merchantId: uuid("merchant_id").references(() => merchants.id, { onDelete: "set null" }),
  note: text("note"),
  transferId: uuid("transfer_id").references((): AnyPgColumn => transactions.id, { onDelete: "set null" }),
  refundOfId: uuid("refund_of_id").references((): AnyPgColumn => transactions.id, { onDelete: "set null" }),
  version: integer("version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("transactions_merchant_id_idx").on(table.merchantId).where(sql`${table.merchantId} is not null`),
  index("transactions_transfer_id_idx").on(table.transferId).where(sql`${table.transferId} is not null`),
  index("transactions_refund_of_id_idx").on(table.refundOfId).where(sql`${table.refundOfId} is not null`),
  check("transactions_kind_check", sql`${table.kind} in ('ordinary', 'transfer', 'refund')`),
  check("transactions_no_self_transfer", sql`${table.transferId} is null or ${table.transferId} <> ${table.id}`),
  check("transactions_no_self_refund", sql`${table.refundOfId} is null or ${table.refundOfId} <> ${table.id}`),
]);

export const transactionSources = pgTable("transaction_sources", {
  transactionId: uuid("transaction_id").notNull().references(() => transactions.id),
  sourceTransactionId: uuid("source_transaction_id").notNull().unique().references(() => sourceTransactions.id),
});

export const correctionEvents = pgTable("correction_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  transactionId: uuid("transaction_id").notNull().references(() => transactions.id),
  actorId: uuid("actor_id").notNull(),
  before: jsonb("before").notNull(),
  after: jsonb("after").notNull(),
  undone: boolean("undone").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const goals = pgTable("goals", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  targetMinor: bigint("target_minor", { mode: "bigint" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  targetDate: date("target_date"),
  priority: integer("priority").notNull().default(0),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
  version: integer("version").notNull().default(0),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("goals_workspace_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
  check("goals_target_minor_check", sql`${table.targetMinor} > 0`),
]);

export const goalAllocations = pgTable("goal_allocations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  goalId: uuid("goal_id").notNull().references(() => goals.id),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
}, (table) => [
  unique("goal_allocations_goal_account_unique").on(table.goalId, table.accountId),
  check("goal_allocations_amount_minor_check", sql`${table.amountMinor} > 0`),
]);

export const financialAssumptions = pgTable("financial_assumptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  accountId: uuid("account_id").references(() => accounts.id),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  cadence: text("cadence").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on"),
  source: text("source").notNull(),
  confidence: integer("confidence"),
  confirmed: boolean("confirmed").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("financial_assumptions_cadence_check", sql`${table.cadence} in ('once', 'daily', 'weekly', 'monthly', 'yearly')`),
  check("financial_assumptions_confidence_check", sql`${table.confidence} between 0 and 100`),
  check("financial_assumptions_dates", sql`${table.endsOn} is null or ${table.endsOn} >= ${table.startsOn}`),
]);

export const scenarios = pgTable("scenarios", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const scenarioOverrides = pgTable("scenario_overrides", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  scenarioId: uuid("scenario_id").notNull().references(() => scenarios.id),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  assumptionId: uuid("assumption_id").references(() => financialAssumptions.id),
  name: text("name").notNull(),
  amountDeltaMinor: bigint("amount_delta_minor", { mode: "bigint" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  cadence: text("cadence").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on"),
}, (table) => [
  check("scenario_overrides_cadence_check", sql`${table.cadence} in ('once', 'daily', 'weekly', 'monthly', 'yearly')`),
  check("scenario_overrides_dates", sql`${table.endsOn} is null or ${table.endsOn} >= ${table.startsOn}`),
]);

export const forecastRuns = pgTable("forecast_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  scenarioId: uuid("scenario_id").references(() => scenarios.id),
  horizonStart: date("horizon_start").notNull(),
  horizonEnd: date("horizon_end").notNull(),
  inputs: jsonb("inputs").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("forecast_runs_dates", sql`${table.horizonEnd} >= ${table.horizonStart}`),
]);

export const backgroundJobs = pgTable("background_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  error: text("error"),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("background_jobs_kind_check", sql`${table.kind} = 'financial_review'`),
  check("background_jobs_status_check", sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'canceled')`),
]);

export const savedAnalyses = pgTable("saved_analyses", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  jobId: uuid("job_id").notNull().unique().references(() => backgroundJobs.id),
  title: text("title").notNull(),
  body: text("body").notNull(),
  evidence: jsonb("evidence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const artifacts = pgTable("artifacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  activeVersionId: uuid("active_version_id"),
  permissions: jsonb("permissions").notNull().default([]),
  createdByConversationId: uuid("created_by_conversation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  foreignKey({ name: "artifacts_active_version_fk", columns: [table.activeVersionId], foreignColumns: [artifactVersions.id] }),
  check("artifacts_kind_check", sql`${table.kind} in ('spending_explorer', 'trip_planner', 'goal_tracker')`),
]);

export const artifactVersions = pgTable("artifact_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  artifactId: uuid("artifact_id").notNull().references((): AnyPgColumn => artifacts.id),
  version: integer("version").notNull(),
  source: text("source").notNull(),
  manifest: jsonb("manifest").notNull(),
  status: text("status").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("artifact_versions_number_unique").on(table.artifactId, table.version),
  check("artifact_versions_version_check", sql`${table.version} > 0`),
  check("artifact_versions_status_check", sql`${table.status} in ('validated', 'failed')`),
]);

export const artifactState = pgTable("artifact_state", {
  artifactId: uuid("artifact_id").primaryKey().references(() => artifacts.id),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  state: jsonb("state").notNull().default({}),
  version: integer("version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const dashboardItems = pgTable("dashboard_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  artifactId: uuid("artifact_id").notNull().references(() => artifacts.id),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [unique("dashboard_items_artifact_unique").on(table.workspaceId, table.artifactId)]);

export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
  role: text("role").notNull(),
  requestId: uuid("request_id"),
  replyTo: uuid("reply_to"),
  content: text("content").notNull(),
  context: jsonb("context"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("messages_request_unique").on(table.conversationId, table.requestId).where(sql`${table.requestId} is not null`),
  uniqueIndex("messages_reply_unique").on(table.conversationId, table.replyTo).where(sql`${table.replyTo} is not null`),
  index("messages_conversation_created").on(table.conversationId, table.createdAt),
  check("messages_role_check", sql`${table.role} in ('user', 'assistant')`),
]);

export const recurringSeries = pgTable("recurring_series", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  label: text("label").notNull(),
  normalizedLabel: text("normalized_label").notNull(),
  cadence: text("cadence").notNull(),
  currencyCode: text("currency_code").notNull(),
  amountMinMinor: bigint("amount_min_minor", { mode: "bigint" }).notNull(),
  amountMaxMinor: bigint("amount_max_minor", { mode: "bigint" }).notNull(),
  occurrences: integer("occurrences").notNull(),
  confidence: integer("confidence"),
  status: text("status").notNull().default("pending"),
  assumptionId: uuid("assumption_id").references(() => financialAssumptions.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("recurring_series_workspace_unique").on(table.workspaceId, table.accountId, table.normalizedLabel, table.cadence, table.currencyCode),
  index("recurring_series_workspace_status").on(table.workspaceId, table.status),
  check("recurring_series_cadence_check", sql`${table.cadence} in ('weekly', 'monthly')`),
  check("recurring_series_occurrences_check", sql`${table.occurrences} >= 3`),
  check("recurring_series_confidence_check", sql`${table.confidence} between 0 and 100`),
  check("recurring_series_status_check", sql`${table.status} in ('pending', 'confirmed', 'dismissed')`),
  check("recurring_series_amounts", sql`${table.amountMinMinor} <= ${table.amountMaxMinor}`),
]);

export const recurringSeriesTransactions = pgTable("recurring_series_transactions", {
  seriesId: uuid("series_id").notNull().references(() => recurringSeries.id, { onDelete: "cascade" }),
  transactionId: uuid("transaction_id").notNull().references(() => transactions.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
}, (table) => [
  primaryKey({ columns: [table.seriesId, table.transactionId] }),
  index("recurring_series_transactions_transaction").on(table.transactionId),
]);

export const fxRates = pgTable("fx_rates", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  fromCurrency: text("from_currency").notNull(),
  toCurrency: text("to_currency").notNull(),
  rateText: text("rate_text").notNull(),
  rateDate: date("rate_date").notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("fx_rates_workspace_pair_date_unique").on(table.workspaceId, table.fromCurrency, table.toCurrency, table.rateDate),
  index("fx_rates_workspace_pair_date_idx").on(table.workspaceId, table.fromCurrency, table.toCurrency, table.rateDate.desc()),
  check("fx_rates_from_currency_check", sql`${table.fromCurrency} ~ '^[A-Z]{3}$'`),
  check("fx_rates_to_currency_check", sql`${table.toCurrency} ~ '^[A-Z]{3}$'`),
  check("fx_rates_rate_text_check", sql`char_length(${table.rateText}) <= 40 and ${table.rateText} ~ '^[0-9]+(\\.[0-9]+)?$'`),
  check("fx_rates_source_check", sql`char_length(${table.source}) between 1 and 120`),
  check("fx_rates_different_currencies", sql`${table.fromCurrency} <> ${table.toCurrency}`),
  check("fx_rates_positive_rate", sql`${table.rateText}::numeric > 0`),
]);

export const spendingPlans = pgTable("spending_plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  categoryId: uuid("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
  currencyCode: text("currency_code").notNull(),
  limitMinor: bigint("limit_minor", { mode: "bigint" }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("spending_plans_workspace_category_currency_unique").on(table.workspaceId, table.categoryId, table.currencyCode),
  index("spending_plans_workspace_idx").on(table.workspaceId),
  check("spending_plans_currency_code", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
  check("spending_plans_limit_positive", sql`${table.limitMinor} > 0`),
]);

export const transactionViews = pgTable("transaction_views", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  filters: jsonb("filters").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("transaction_views_workspace_idx").on(table.workspaceId, table.createdAt.desc()),
  check("transaction_views_name_length", sql`char_length(${table.name}) between 1 and 80`),
  check("transaction_views_filters_object", sql`jsonb_typeof(${table.filters}) = 'object'`),
]);
