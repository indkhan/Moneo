import { pgTable, uuid, text, timestamp, date, bigint, integer, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().unique(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("imports_workspace_hash_unique").on(table.workspaceId, table.fileHash)]);

export const sourceTransactions = pgTable("source_transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  importId: uuid("import_id").notNull().references(() => imports.id),
  rowNumber: integer("row_number").notNull(),
  originalRow: jsonb("original_row").notNull(),
  externalId: text("external_id"),
  status: text("status").notNull().default("new"),
}, (table) => [uniqueIndex("source_transactions_import_row_unique").on(table.importId, table.rowNumber)]);

export const categories = pgTable("categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
}, (table) => [uniqueIndex("categories_workspace_name_unique").on(table.workspaceId, table.name)]);

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
  note: text("note"),
  transferId: uuid("transfer_id"),
  refundOfId: uuid("refund_of_id"),
  version: integer("version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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
}, (table) => [uniqueIndex("goals_workspace_idempotency_unique").on(table.workspaceId, table.idempotencyKey)]);

export const goalAllocations = pgTable("goal_allocations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  goalId: uuid("goal_id").notNull().references(() => goals.id),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
}, (table) => [uniqueIndex("goal_allocations_goal_account_unique").on(table.goalId, table.accountId)]);

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
});

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
});

export const forecastRuns = pgTable("forecast_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  scenarioId: uuid("scenario_id").references(() => scenarios.id),
  horizonStart: date("horizon_start").notNull(),
  horizonEnd: date("horizon_end").notNull(),
  inputs: jsonb("inputs").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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
});

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
});

export const artifactVersions = pgTable("artifact_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  artifactId: uuid("artifact_id").notNull().references(() => artifacts.id),
  version: integer("version").notNull(),
  source: text("source").notNull(),
  manifest: jsonb("manifest").notNull(),
  status: text("status").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("artifact_versions_number_unique").on(table.artifactId, table.version)]);

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
}, (table) => [uniqueIndex("dashboard_items_artifact_unique").on(table.workspaceId, table.artifactId)]);

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
});
