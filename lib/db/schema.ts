import { sql } from "drizzle-orm";
import { pgTable, pgSchema, uuid, text, timestamp, date, bigint, integer, jsonb, boolean, uniqueIndex, unique, index, check, foreignKey, primaryKey, type AnyPgColumn } from "drizzle-orm/pg-core";

export const dashboardLayouts = pgTable("dashboard_layouts", {
  workspaceId: uuid("workspace_id").primaryKey().references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }),
  items: text("items").array().notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("dashboard_layouts_items_check", sql`cardinality(${table.items}) <= 50`),
  check("dashboard_layouts_version_check", sql`${table.version} > 0`),
]);

// Supabase owns the rest of auth.users; only its referenced primary key belongs here.
const authUsers = pgSchema("auth").table("users", { id: uuid("id").primaryKey() });

export const summaryRuns = pgTable("summary_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references((): AnyPgColumn => backgroundJobs.id),
  periodStart: date("period_start").notNull(),
  cadence: text("cadence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("summary_runs_workspace_id_cadence_period_start_key").on(table.workspaceId, table.cadence, table.periodStart),
  check("summary_runs_cadence_check", sql`${table.cadence} in ('weekly','monthly')`),
]);

export const transactionSplitSets = pgTable("transaction_split_sets", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references((): AnyPgColumn => workspaces.id),
  transactionId: uuid("transaction_id").notNull().references((): AnyPgColumn => transactions.id),
  requestId: uuid("request_id").notNull(),
  actorId: uuid("actor_id").notNull().references(() => authUsers.id),
  before: jsonb("before").notNull(), after: jsonb("after").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoneBy: uuid("undone_by").references(() => authUsers.id),
}, (table) => [
  unique("transaction_split_sets_workspace_id_request_id_key").on(table.workspaceId, table.requestId),
  uniqueIndex("transaction_split_sets_one_active").on(table.transactionId).where(sql`${table.undoneAt} is null`),
]);

export const transactionSplits = pgTable("transaction_splits", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references((): AnyPgColumn => workspaces.id),
  parentTransactionId: uuid("parent_transaction_id").notNull().references((): AnyPgColumn => transactions.id),
  splitSetId: uuid("split_set_id").notNull().references(() => transactionSplitSets.id),
  categoryId: uuid("category_id").references((): AnyPgColumn => categories.id),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  note: text("note").notNull().default(""),
  ordinal: integer("ordinal").notNull(),
}, (table) => [
  unique("transaction_splits_split_set_id_ordinal_key").on(table.splitSetId, table.ordinal),
  check("transaction_splits_amount_minor_check", sql`${table.amountMinor} <> 0`),
  check("transaction_splits_note_check", sql`char_length(${table.note}) <= 500`),
  check("transaction_splits_ordinal_check", sql`${table.ordinal} between 1 and 20`),
]);

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
  version: integer("version").notNull().default(1),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
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
  boundaryKind: text("boundary_kind").notNull().default("date_only"),
  sourceTransactionId: uuid("source_transaction_id").references((): AnyPgColumn => sourceTransactions.id),
  coveredTransactions: jsonb("covered_transactions"),
  actorId: uuid("actor_id").references(() => authUsers.id),
  commandInput: jsonb("command_input"),
  version: integer("version").notNull().default(1),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoneBy: uuid("undone_by").references(() => authUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("balance_snapshots_boundary_kind_check", sql`${table.boundaryKind} in ('date_only','after_transaction','reviewed_activity') and (${table.boundaryKind} <> 'after_transaction' or ${table.sourceTransactionId} is not null) and (${table.boundaryKind} <> 'reviewed_activity' or (${table.coveredTransactions} is not null and jsonb_typeof(${table.coveredTransactions}) = 'array' and ${table.actorId} is not null))`),
  check("balance_snapshots_version_check", sql`${table.version} > 0`),
]);

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
  runVersion: integer("run_version").notNull().default(1),
  routeAccounts: jsonb("route_accounts").notNull().default({}),
  mapping: jsonb("mapping"),
  totalRows: integer("total_rows").notNull().default(0),
  newRows: integer("new_rows").notNull().default(0),
  matchedRows: integer("matched_rows").notNull().default(0),
  reviewRows: integer("review_rows").notNull().default(0),
  classificationReviewRows: integer("classification_review_rows").notNull().default(0),
  rejectedRows: integer("rejected_rows").notNull().default(0),
  error: text("error"),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoneBy: uuid("undone_by").references(() => authUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex("imports_workspace_hash_unique").on(table.workspaceId, table.fileHash).where(sql`${table.status} <> 'undone'`),
  check("imports_classification_review_rows_check", sql`${table.classificationReviewRows} >= 0`),
  check("imports_run_version_check", sql`${table.runVersion} > 0`),
  check("imports_route_accounts_check", sql`jsonb_typeof(${table.routeAccounts}) = 'object'`),
]);

export const importControlEvents = pgTable("import_control_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  importId: uuid("import_id").notNull().references(() => imports.id),
  requestId: uuid("request_id").notNull(), action: text("action").notNull(), result: jsonb("result").notNull(),
  actorId: uuid("actor_id").notNull().references(() => authUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [unique("import_control_events_workspace_id_request_id_key").on(table.workspaceId, table.requestId),
  check("import_control_events_action_check", sql`${table.action} in ('cancel','resume')`),
  check("import_control_events_result_check", sql`jsonb_typeof(${table.result}) = 'object'`)]);

export const sourceTransactions = pgTable("source_transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  importId: uuid("import_id").notNull().references(() => imports.id),
  rowNumber: integer("row_number").notNull(),
  originalRow: jsonb("original_row").notNull(),
  feeEvidence: jsonb("fee_evidence"),
  externalId: text("external_id"),
  reviewReasons: text("review_reasons").array().notNull().default(sql`'{}'::text[]`),
  status: text("status").notNull().default("new"),
}, (table) => [
  unique("source_transactions_import_row_unique").on(table.importId, table.rowNumber),
  check("source_transactions_fee_evidence_check", sql`${table.feeEvidence} is null or (jsonb_typeof(${table.feeEvidence}) = 'object' and ${table.feeEvidence} ? 'treatment' and ${table.feeEvidence}->>'treatment' is not null and ${table.feeEvidence}->>'treatment' in ('included','additional','unknown'))`),
  check("source_transactions_review_reasons_check", sql`${table.reviewReasons} <@ array['source_transfer','source_exchange','source_type','refund_sign','fee_semantics','excluded_by_review']::text[]`),
]);

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
  postedAt: timestamp("posted_at", { withTimezone: true }),
  description: text("description").notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  eventName: text("event_name"),
  reviewReasons: text("review_reasons").array().notNull().default(sql`'{}'::text[]`),
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
  index("transactions_account_posted_at_idx").on(table.workspaceId, table.accountId, table.postedAt).where(sql`${table.postedAt} is not null`),
  index("transactions_transfer_id_idx").on(table.transferId).where(sql`${table.transferId} is not null`),
  index("transactions_refund_of_id_idx").on(table.refundOfId).where(sql`${table.refundOfId} is not null`),
  check("transactions_review_reasons_check", sql`${table.reviewReasons} <@ array['source_transfer','source_exchange','source_type','refund_sign','fee_semantics']::text[]`),
  check("transactions_tags_count", sql`cardinality(${table.tags}) <= 20`),
  check("transactions_event_name_length", sql`length(${table.eventName}) <= 120`),
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
  plannedMonthlyMinor: bigint("planned_monthly_minor", { mode: "bigint" }).notNull().default(0n),
  contributionStartsOn: date("contribution_starts_on"),
  recordedSavedMinor: bigint("recorded_saved_minor", { mode: "bigint" }),
  savedAsOf: date("saved_as_of"),
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
  check("goals_planned_monthly_minor_check", sql`${table.plannedMonthlyMinor} >= 0`),
  check("goals_recorded_saved_minor_check", sql`${table.recordedSavedMinor} >= 0`),
  check("goals_saved_evidence_check", sql`(${table.recordedSavedMinor} is null) = (${table.savedAsOf} is null)`),
  check("goals_contribution_date_check", sql`${table.plannedMonthlyMinor} = 0 or ${table.contributionStartsOn} is not null`),
]);

export const goalEvents = pgTable("goal_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  goalId: uuid("goal_id").notNull().references(() => goals.id),
  actorId: uuid("actor_id").references(() => authUsers.id),
  before: jsonb("before"), after: jsonb("after").notNull(), requestId: uuid("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  undone: boolean("undone").notNull().default(false),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoneBy: uuid("undone_by").references(() => authUsers.id),
}, (table) => [unique("goal_events_workspace_id_request_id_key").on(table.workspaceId, table.requestId)]);

export const wealthItems = pgTable("wealth_items", {
  id: uuid("id").primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  kind: text("kind").notNull(), name: text("name").notNull(), currencyCode: text("currency_code").notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(), quantityText: text("quantity_text"), unitPriceText: text("unit_price_text"),
  costBasisMinor: bigint("cost_basis_minor", { mode: "bigint" }), asOf: date("as_of").notNull(),
  linkedAccountId: uuid("linked_account_id").references(() => accounts.id), paymentAccountId: uuid("payment_account_id").references(() => accounts.id),
  annualRateText: text("annual_rate_text"), monthlyPaymentMinor: bigint("monthly_payment_minor", { mode: "bigint" }), nextPaymentOn: date("next_payment_on"),
  paymentAssumptionId: uuid("payment_assumption_id").references((): AnyPgColumn => financialAssumptions.id), paymentTransactionId: uuid("payment_transaction_id").references(() => transactions.id),
  version: integer("version").notNull().default(1), removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("wealth_items_kind_check", sql`${table.kind} in ('holding','asset','debt')`),
  check("wealth_items_name_check", sql`char_length(${table.name}) between 1 and 120`),
  check("wealth_items_currency_code_check", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
  check("wealth_items_check", sql`(${table.kind} = 'debt' and ${table.amountMinor} <= 0) or (${table.kind} <> 'debt' and ${table.amountMinor} >= 0)`),
  check("wealth_items_cost_basis_minor_check", sql`${table.costBasisMinor} is null or ${table.costBasisMinor} >= 0`),
  check("wealth_items_monthly_payment_minor_check", sql`${table.monthlyPaymentMinor} is null or ${table.monthlyPaymentMinor} >= 0`),
]);

export const wealthEvents = pgTable("wealth_events", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  itemId: uuid("item_id").notNull().references(() => wealthItems.id), actorId: uuid("actor_id").notNull().references(() => authUsers.id),
  requestId: uuid("request_id").notNull(), before: jsonb("before"), after: jsonb("after").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  undoneAt: timestamp("undone_at", { withTimezone: true }), undoneBy: uuid("undone_by").references(() => authUsers.id),
}, (table) => [unique("wealth_events_workspace_id_request_id_key").on(table.workspaceId, table.requestId)]);

export const forecastPreferences = pgTable("forecast_preferences", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id), currencyCode: text("currency_code").notNull(),
  safetyBufferMinor: bigint("safety_buffer_minor", { mode: "bigint" }).notNull().default(0n), dailySpendingMinor: bigint("daily_spending_minor", { mode: "bigint" }).notNull().default(0n),
  uncertaintyBps: integer("uncertainty_bps").notNull().default(1000), spendingAccountId: uuid("spending_account_id").references(() => accounts.id), spendingStartsOn: date("spending_starts_on"),
  version: integer("version").notNull().default(1), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("forecast_preferences_currency_code_check", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
  check("forecast_preferences_safety_buffer_minor_check", sql`${table.safetyBufferMinor} >= 0`), check("forecast_preferences_daily_spending_minor_check", sql`${table.dailySpendingMinor} >= 0`),
  check("forecast_preferences_uncertainty_bps_check", sql`${table.uncertaintyBps} between 0 and 10000`), check("forecast_preferences_version_check", sql`${table.version} > 0`),
  check("forecast_preferences_check", sql`${table.dailySpendingMinor} = 0 or (${table.spendingAccountId} is not null and ${table.spendingStartsOn} is not null)`),
]);

export const forecastPreferenceEvents = pgTable("forecast_preference_events", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id), actorId: uuid("actor_id").notNull().references(() => authUsers.id),
  before: jsonb("before"), after: jsonb("after").notNull(), requestId: uuid("request_id").notNull(), undoOf: uuid("undo_of").references((): AnyPgColumn => forecastPreferenceEvents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), undoneAt: timestamp("undone_at", { withTimezone: true }),
}, (table) => [unique("forecast_preference_events_workspace_id_request_id_key").on(table.workspaceId, table.requestId)]);

export const goalAllocations = pgTable("goal_allocations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  goalId: uuid("goal_id").notNull().references(() => goals.id),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  version: integer("version").notNull().default(1),
}, (table) => [
  unique("goal_allocations_goal_account_unique").on(table.goalId, table.accountId),
  check("goal_allocations_amount_minor_check", sql`${table.amountMinor} >= 0`),
]);

export const goalReservationEvents = pgTable("goal_reservation_events", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  allocationId: uuid("allocation_id").notNull().references(() => goalAllocations.id), actorId: uuid("actor_id").notNull().references(() => authUsers.id),
  before: jsonb("before").notNull(), after: jsonb("after").notNull(), requestId: uuid("request_id").notNull(),
  undoOf: uuid("undo_of").references((): AnyPgColumn => goalReservationEvents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  undoneAt: timestamp("undone_at", { withTimezone: true }), undoneBy: uuid("undone_by").references(() => authUsers.id),
}, (table) => [unique("goal_reservation_events_workspace_id_request_id_key").on(table.workspaceId, table.requestId)]);

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
  version: integer("version").notNull().default(1),
  removedAt: timestamp("removed_at", { withTimezone: true }),
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
  version: integer("version").notNull().default(1),
  removedAt: timestamp("removed_at", { withTimezone: true }),
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
  version: integer("version").notNull().default(1),
  removedAt: timestamp("removed_at", { withTimezone: true }),
}, (table) => [
  check("scenario_overrides_cadence_check", sql`${table.cadence} in ('once', 'daily', 'weekly', 'monthly', 'yearly')`),
  check("scenario_overrides_dates", sql`${table.endsOn} is null or ${table.endsOn} >= ${table.startsOn}`),
]);

export const scenarioEvents = pgTable("scenario_events", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  entityType: text("entity_type").notNull(), entityId: uuid("entity_id").notNull(), actorId: uuid("actor_id").references(() => authUsers.id),
  before: jsonb("before"), after: jsonb("after").notNull(), requestId: uuid("request_id"), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  undone: boolean("undone").notNull().default(false), undoneAt: timestamp("undone_at", { withTimezone: true }), undoneBy: uuid("undone_by").references(() => authUsers.id),
}, table => [unique("scenario_events_workspace_id_request_id_key").on(table.workspaceId,table.requestId),check("scenario_events_entity_type_check",sql`${table.entityType} in ('scenario','override')`)]);

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
  requestId: uuid("request_id"),
  chatRequestId: uuid("chat_request_id").references((): AnyPgColumn => chatRequests.id, { onDelete: "set null" }),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  error: text("error"),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("background_jobs_kind_check", sql`${table.kind} = 'financial_review'`),
  check("background_jobs_status_check", sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'canceled')`),
  unique("background_jobs_workspace_request_key").on(table.workspaceId, table.requestId),
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
  check("artifacts_kind_check", sql`${table.kind} in ('spending_explorer','trip_planner','goal_tracker','custom_planner','custom_tracker','custom_report','custom_comparison')`),
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
  evidenceInvalidated: boolean("evidence_invalidated").notNull().default(false),
  evidenceBaseline: jsonb("evidence_baseline"), assumptionRestore: jsonb("assumption_restore"), invalidatedAssumptionVersion: integer("invalidated_assumption_version"),
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

export const recurringOccurrenceSettlements = pgTable("recurring_occurrence_settlements", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  assumptionId: uuid("assumption_id").notNull(),
  scheduledOn: date("scheduled_on").notNull(),
  transactionId: uuid("transaction_id").notNull(),
  completesOccurrence: boolean("completes_occurrence").notNull(),
  receipt: jsonb("receipt").notNull(),
  actorId: uuid("actor_id").notNull().references(() => authUsers.id),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("recurring_occurrence_active_transaction").on(table.transactionId).where(sql`${table.undoneAt} is null`),
  index("recurring_occurrence_workspace").on(table.workspaceId, table.assumptionId, table.scheduledOn),
  check("recurring_occurrence_settlements_receipt_check", sql`jsonb_typeof(${table.receipt}) = 'object'`),
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
  rollover: boolean("rollover").notNull().default(false),
  rolloverFrom: date("rollover_from").notNull().default(sql`date_trunc('month',now() at time zone 'Europe/Berlin')::date`),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("spending_plans_workspace_category_currency_unique").on(table.workspaceId, table.categoryId, table.currencyCode),
  index("spending_plans_workspace_idx").on(table.workspaceId),
  check("spending_plans_currency_code", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
  check("spending_plans_limit_positive", sql`${table.limitMinor} > 0`),
  check("spending_plans_rollover_from_check", sql`extract(day from ${table.rolloverFrom})=1`),
]);

export const spendingPlanLimits = pgTable("spending_plan_limits", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id), planId: uuid("plan_id").notNull(),
  limitMinor: bigint("limit_minor", { mode: "bigint" }).notNull(), enabled: boolean("enabled").notNull(), version: integer("version").notNull(),
  effectiveMonth: date("effective_month").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [unique("spending_plan_limits_workspace_id_plan_id_version_key").on(table.workspaceId,table.planId,table.version),
  check("spending_plan_limits_limit_minor_check",sql`${table.limitMinor}>0`), check("spending_plan_limits_version_check",sql`${table.version}>0`),
  check("spending_plan_limits_effective_month_check",sql`extract(day from ${table.effectiveMonth})=1`)]);

export const artifactGenerationRequests = pgTable("artifact_generation_requests", {
  id: uuid("id").primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "cascade" }), purpose: text("purpose").notNull(), description: text("description").notNull(),
  status: text("status").notNull().default("queued"), result: jsonb("result"), error: text("error"), usage: jsonb("usage"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [index("artifact_generation_requests_workspace_created_idx").on(table.workspaceId,table.createdAt.desc()),
  check("artifact_generation_requests_purpose_check",sql`${table.purpose} in ('proposal','calculator')`),
  check("artifact_generation_requests_description_check",sql`length(btrim(${table.description})) between 1 and 500`),
  check("artifact_generation_requests_status_check",sql`${table.status} in ('queued','running','completed','failed','canceled')`),
  check("artifact_generation_requests_result_check",sql`${table.result} is null or (jsonb_typeof(${table.result})='object' and octet_length(${table.result}::text)<=65536)`),
  check("artifact_generation_requests_error_check",sql`${table.error} is null or length(${table.error})<=2000`),
  check("artifact_generation_requests_usage_check",sql`${table.usage} is null or (jsonb_typeof(${table.usage})='object' and octet_length(${table.usage}::text)<=2000)`),
  check("artifact_generation_requests_check",sql`(${table.purpose}='calculator' and ${table.artifactId} is not null) or (${table.purpose}='proposal' and ${table.artifactId} is null)`),
  check("artifact_generation_requests_check1",sql`(${table.status}='completed' and ${table.result} is not null and ${table.error} is null) or (${table.status}<>'completed' and ${table.result} is null)`)]);

export const insightPreferences = pgTable("insight_preferences", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }), importantOnly: boolean("important_only").notNull().default(true),
  minimumChangeMinor: bigint("minimum_change_minor", { mode: "bigint" }).notNull().default(2000n), currencyCode: text("currency_code").notNull().default("EUR"),
  upcomingDays: integer("upcoming_days").notNull().default(7), maxItems: integer("max_items").notNull().default(8), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [check("insight_preferences_minimum_change_minor_check",sql`${table.minimumChangeMinor}>=0`),check("insight_preferences_currency_code_check",sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
  check("insight_preferences_upcoming_days_check",sql`${table.upcomingDays} between 1 and 30`),check("insight_preferences_max_items_check",sql`${table.maxItems} between 1 and 20`)]);

export const insightDismissals = pgTable("insight_dismissals", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }), evidenceKey: text("evidence_key").notNull(), insightType: text("insight_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [primaryKey({ columns: [table.workspaceId,table.evidenceKey] }),check("insight_dismissals_evidence_key_check",sql`${table.evidenceKey} ~ '^[0-9a-f]{64}$'`),
  check("insight_dismissals_insight_type_check",sql`${table.insightType} in ('spending_changes','budget_pressure','unusual_activity','recurring_changes','upcoming_obligations','cash_shortfall','goal_progress','asset_debt','data_quality')`)]);

export const transactionLinks = pgTable("transaction_links", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  primaryTransactionId: uuid("primary_transaction_id").notNull().references(() => transactions.id), counterpartTransactionId: uuid("counterpart_transaction_id").notNull().references(() => transactions.id),
  operation: text("operation").notNull(), requestId: uuid("request_id").notNull(), input: jsonb("input").notNull(),
  beforeRows: jsonb("before_rows").notNull(), afterRows: jsonb("after_rows").notNull(), fxEvidence: jsonb("fx_evidence"), originalEquivalentMinor: bigint("original_equivalent_minor", { mode: "bigint" }),
  actorId: uuid("actor_id").notNull().references(() => authUsers.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  undoneAt: timestamp("undone_at", { withTimezone: true }), undoneBy: uuid("undone_by").references(() => authUsers.id),
}, table => [unique("transaction_links_workspace_id_request_id_key").on(table.workspaceId,table.requestId),
  uniqueIndex("transaction_links_active_primary").on(table.primaryTransactionId).where(sql`${table.undoneAt} is null`),check("transaction_links_operation_check",sql`${table.operation} in ('transfer','refund')`)]);

export const transactionLinkFees = pgTable("transaction_link_fees", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id), linkId: uuid("link_id").notNull().references(() => transactionLinks.id),
  transactionId: uuid("transaction_id").notNull().references(() => transactions.id), feeMinor: bigint("fee_minor", { mode: "bigint" }).notNull(), treatment: text("treatment").notNull(),
  categoryId: uuid("category_id").references(() => categories.id), note: text("note").notNull(),
}, table => [unique("transaction_link_fees_link_id_transaction_id_key").on(table.linkId,table.transactionId), check("transaction_link_fees_fee_minor_check",sql`${table.feeMinor}>0`),
  check("transaction_link_fees_treatment_check",sql`${table.treatment} in ('included','additional')`),check("transaction_link_fees_note_check",sql`length(btrim(${table.note})) between 1 and 500`)]);

export const transactionViews = pgTable("transaction_views", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  filters: jsonb("filters").notNull().default({}),
  version: integer("version").notNull().default(1),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("transaction_views_workspace_idx").on(table.workspaceId, table.createdAt.desc()),
  check("transaction_views_name_length", sql`char_length(${table.name}) between 1 and 80`),
  check("transaction_views_filters_object", sql`jsonb_typeof(${table.filters}) = 'object'`),
]);

export const moneyMetadataEvents = pgTable("money_metadata_events", {
  id: uuid("id").defaultRandom().primaryKey(), workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  entityType: text("entity_type").notNull(), entityId: uuid("entity_id").notNull(), actorId: uuid("actor_id").notNull().references(() => authUsers.id),
  before: jsonb("before").notNull(), after: jsonb("after").notNull(), input: jsonb("input").notNull(), requestId: uuid("request_id").notNull(),
  undoOf: uuid("undo_of").references((): AnyPgColumn => moneyMetadataEvents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  undoneAt: timestamp("undone_at", { withTimezone: true }), undoneBy: uuid("undone_by").references(() => authUsers.id),
}, table => [unique("money_metadata_events_workspace_id_request_id_key").on(table.workspaceId, table.requestId),
  check("money_metadata_events_entity_type_check", sql`${table.entityType} in ('account','transaction_view')`)]);

export const planningEvents = pgTable("planning_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  actorId: uuid("actor_id").references(() => authUsers.id),
  before: jsonb("before"),
  after: jsonb("after"),
  requestId: uuid("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  undone: boolean("undone").notNull().default(false),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoneBy: uuid("undone_by").references(() => authUsers.id),
}, (table) => [
  unique("planning_events_workspace_id_request_id_key").on(table.workspaceId, table.requestId),
  index("planning_events_entity_idx").on(table.workspaceId, table.entityType, table.entityId, table.createdAt),
  check("planning_events_entity_type_check", sql`${table.entityType} in ('assumption', 'spending_plan')`),
]);

export const chatRequests = pgTable("chat_requests", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
  context: jsonb("context").notNull().default({}),
  status: text("status").notNull().default("running"),
  allowedTransactionId: uuid("allowed_transaction_id"),
  allowedCategory: text("allowed_category"),
  actionResult: jsonb("action_result"),
  usage: jsonb("usage"),
  answer: text("answer"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("chat_requests_workspace_created").on(table.workspaceId, table.createdAt),
  check("chat_requests_status_check", sql`${table.status} in ('running','completed','failed','canceled')`),
]);

export const manualTransactionEntries = pgTable("manual_transaction_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  transactionId: uuid("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
  requestId: uuid("request_id").notNull(),
  actorId: uuid("actor_id").notNull().references(() => authUsers.id),
  originalRecord: jsonb("original_record").notNull(),
  version: integer("version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoneBy: uuid("undone_by").references(() => authUsers.id),
}, (table) => [unique("manual_transaction_entries_workspace_id_request_id_key").on(table.workspaceId, table.requestId)]);

export const transactionBatches = pgTable("transaction_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").notNull(),
  actorId: uuid("actor_id").notNull().references(() => authUsers.id),
  selection: jsonb("selection").notNull(),
  patch: jsonb("patch").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  undone: boolean("undone").notNull().default(false),
}, (table) => [unique("transaction_batches_workspace_id_request_id_key").on(table.workspaceId, table.requestId)]);

export const workspaceSettings = pgTable("workspace_settings", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  timezone: text("timezone").notNull().default("Europe/Berlin"),
  locale: text("locale").notNull().default("en-GB"),
  theme: text("theme").notNull().default("system"),
  openrouterModel: text("openrouter_model"),
  aiDataScopes: text("ai_data_scopes").array().notNull().default(sql`array['accounts','transactions','planning','imports']::text[]`),
  mutedInsightTypes: text("muted_insight_types").array().notNull().default(sql`'{}'::text[]`),
  summaryCadence: text("summary_cadence").notNull().default("none"),
  summaryTime: text("summary_time").notNull().default("09:00"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("workspace_settings_timezone_check", sql`length(${table.timezone}) between 1 and 100`),
  check("workspace_settings_locale_check", sql`length(${table.locale}) between 1 and 50`),
  check("workspace_settings_theme_check", sql`${table.theme} in ('system','light','dark')`),
  check("workspace_settings_openrouter_model_check", sql`length(${table.openrouterModel}) between 1 and 200`),
  check("workspace_settings_ai_data_scopes_check", sql`${table.aiDataScopes} <@ array['accounts','transactions','planning','imports']::text[]`),
  check("workspace_settings_muted_insight_types_check", sql`${table.mutedInsightTypes} <@ array['spending_changes','budget_pressure','unusual_activity','recurring_changes','upcoming_obligations','cash_shortfall','goal_progress','asset_debt','data_quality']::text[]`),
  check("workspace_settings_summary_cadence_check", sql`${table.summaryCadence} in ('none','weekly','monthly')`),
  check("workspace_settings_summary_time_check", sql`${table.summaryTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
]);
