import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "./uuid.js";

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

/**
 * Epoch 1 identity + tenancy tables.
 *
 * - Primary keys are application-generated UUIDv7 (`uuidv7()`), time-ordered
 *   without a database extension.
 * - `workspace_members` is a junction table keyed by `(workspace_id, user_id)`:
 *   both halves of the key are the tenant + identity, so isolation holds by
 *   construction (the `(workspace_id, id)` rule applies to tenant-owned entity
 *   tables introduced in later epochs; every FK below that references a
 *   tenant row carries `workspace_id`, never a bare cross-workspace id).
 * - `security_audit_events.workspace_id` is nullable because some security
 *   events (failed logins, unknown subjects) precede workspace context. The
 *   app role can only read/write rows whose workspace matches
 *   `app.current_workspace` (see migration `0002_workspace_rls`); global
 *   events stay visible to the migration/owner role only.
 */
export const users = pgTable("users", {
  /** Global identity row, one per Auth0 subject. Never carries workspace_id. */
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  /** Stable Auth0 `sub` claim, e.g. `auth0|abc123`. Unique: one row per subject. */
  authSubject: text("auth_subject").notNull().unique(),
  email: text("email"),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const workspaces = pgTable("workspaces", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  name: text("name").notNull(),
  /** Provisioning actor. Nullable: set once the creator's user row exists. */
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;

export type WorkspaceRole = "OWNER" | "MEMBER";

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("MEMBER"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    check("workspace_members_role_check", sql`${t.role} in ('OWNER', 'MEMBER')`),
  ],
);

export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;

export const securityAuditEvents = pgTable(
  "security_audit_events",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Machine-readable event name, e.g. `user.provisioned`, `session.revoked`. */
    eventType: text("event_type").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("security_audit_events_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);

export type SecurityAuditEvent = typeof securityAuditEvents.$inferSelect;
export type NewSecurityAuditEvent = typeof securityAuditEvents.$inferInsert;

/**
 * Epoch 2, Issue 2.1 — reliable-mutation infrastructure.
 *
 * - `command_operations`: one row per typed domain command attempt. The
 *   UNIQUE(workspace_id, command_name, idempotency_key) constraint IS the
 *   idempotency claim: the first insert wins, a replay hits the conflict and
 *   re-reads the stored result instead of re-mutating. RLS pins every
 *   app-role read/write to the current workspace, so a key in workspace A
 *   can never collide with workspace B.
 * - `audit_events`: immutable domain audit trail (finance history UI reads
 *   this in Epoch 5). Rows are insert-only by convention; no UPDATE policy is
 *   granted to the app role.
 * - `outbox_events`: transactional outbox. Command handlers insert rows in
 *   the SAME database transaction as the business mutation, so an event can
 *   never exist without its effect (and vice versa). The dispatcher
 *   (Issue 2.5) claims rows with FOR UPDATE SKIP LOCKED and publishes each
 *   to BullMQ under the deterministic job id `outbox:{eventId}`.
 */
export const commandOperations = pgTable(
  "command_operations",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Typed command name, e.g. `transactions.setCategory`. */
    commandName: text("command_name").notNull(),
    /** Client-supplied key, scoped per command: same key + same command = replay. */
    idempotencyKey: text("idempotency_key").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Optimistic-concurrency guard supplied by the caller, if any. */
    expectedVersion: bigint("expected_version", { mode: "number" }),
    /** Entity version after the mutation, if the command is versioned. */
    resultingVersion: bigint("resulting_version", { mode: "number" }),
    status: text("status").notNull().default("succeeded"),
    /** Stored command result returned verbatim on idempotent replay. */
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("command_operations_workspace_command_key_uniq").on(
      t.workspaceId,
      t.commandName,
      t.idempotencyKey,
    ),
    check(
      "command_operations_status_check",
      sql`${t.status} in ('claimed', 'succeeded', 'failed')`,
    ),
    index("command_operations_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export type CommandOperation = typeof commandOperations.$inferSelect;
export type NewCommandOperation = typeof commandOperations.$inferInsert;

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    commandOperationId: uuid("command_operation_id").references(() => commandOperations.id, {
      onDelete: "set null",
    }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** What changed, e.g. `transaction`. */
    entityType: text("entity_type").notNull(),
    /** Opaque entity id within the workspace. */
    entityId: text("entity_id").notNull(),
    /** What happened, e.g. `transactions.setCategory`. */
    action: text("action").notNull(),
    oldValue: jsonb("old_value").$type<Record<string, unknown> | null>(),
    newValue: jsonb("new_value").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_workspace_entity_idx").on(t.workspaceId, t.entityType, t.entityId),
    index("audit_events_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;

export type OutboxStatus = "pending" | "claimed" | "published" | "failed";

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    /** Dispatcher attempt counter (Issue 2.5). */
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "outbox_events_status_check",
      sql`${t.status} in ('pending', 'claimed', 'published', 'failed')`,
    ),
    index("outbox_events_dispatch_idx").on(t.status, t.nextAttemptAt, t.createdAt),
    index("outbox_events_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;

/**
 * Epoch 2, Issue 2.4 — durable job truth.
 *
 * PostgreSQL holds job STATE; BullMQ/Redis is only execution transport
 * (Issue 2.5/2.6). At-least-once delivery is assumed, so every business step
 * a job performs must be idempotent and every state change is recorded in
 * `background_job_attempts` for the Epoch 2 acceptance trail.
 *
 * - `background_jobs`: one row per unit of background work. `dedupe_key` is
 *   optional: when set, UNIQUE(workspace_id, type, dedupe_key) makes enqueue
 *   idempotent (retried HTTP submissions create one job, not N).
 * - `background_job_attempts`: one row per execution try, including crashes
 *   (a `started` row with a stale heartbeat is how Issue 2.6 detects them).
 * - `scheduled_tasks`: global cron registry (no workspace: schedules run
 *   across workspaces, like `currencies` it carries no RLS policy).
 */
export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    status: text("status").notNull().default("queued"),
    /** Optional caller key making enqueue idempotent per (workspace, type). */
    dedupeKey: text("dedupe_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    error: jsonb("error").$type<Record<string, unknown> | null>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    /** Not eligible for pickup before this timestamp (delays + backoff). */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    /** Worker currently holding the job, if any (crash detection via staleness). */
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    /** UI progress (Issue 2.8): free-form stage + 0–100 percent. */
    progressStage: text("progress_stage"),
    progressPercent: integer("progress_percent"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "background_jobs_status_check",
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    unique("background_jobs_workspace_type_dedupe_uniq").on(t.workspaceId, t.type, t.dedupeKey),
    index("background_jobs_pickup_idx").on(t.status, t.runAfter, t.createdAt),
    index("background_jobs_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export type BackgroundJob = typeof backgroundJobs.$inferSelect;
export type NewBackgroundJob = typeof backgroundJobs.$inferInsert;

export const backgroundJobAttempts = pgTable(
  "background_job_attempts",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    jobId: uuid("job_id")
      .notNull()
      .references(() => backgroundJobs.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull().default("started"),
    error: jsonb("error").$type<Record<string, unknown> | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "background_job_attempts_status_check",
      sql`${t.status} in ('started', 'succeeded', 'failed')`,
    ),
    unique("background_job_attempts_job_number_uniq").on(t.jobId, t.attemptNumber),
    index("background_job_attempts_job_idx").on(t.jobId, t.attemptNumber),
  ],
);

export type BackgroundJobAttempt = typeof backgroundJobAttempts.$inferSelect;
export type NewBackgroundJobAttempt = typeof backgroundJobAttempts.$inferInsert;

export const scheduledTasks = pgTable("scheduled_tasks", {
  /** Stable task name, e.g. `outbox.dispatch`. One row per schedule. */
  name: text("name").primaryKey(),
  /** Cron expression (minute granularity is enough for Epoch 2). */
  schedule: text("schedule").notNull(),
  enabled: integer("enabled").notNull().default(1),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
});

export type ScheduledTask = typeof scheduledTasks.$inferSelect;
export type NewScheduledTask = typeof scheduledTasks.$inferInsert;

/**
 * Epoch 3, Issue 3.1 — source ingestion layer.
 *
 * Raw observations are preserved: file bytes live in quarantine storage
 * (Issue 3.2), parsed rows land here, and canonical finance state (Epoch 4)
 * is derived WITHOUT deleting these rows.
 *
 * Tenancy follows the Epoch 1/2 pattern: every table carries `workspace_id`,
 * every FK to a tenant row is scoped by RLS to `app.current_workspace`, and
 * the app role never bypasses RLS.
 *
 * Uniqueness notes (PostgreSQL NULL semantics do the work, no partial-index
 * syntax needed): UNIQUE(a, b) with nullable b permits unlimited NULL b rows
 * while rejecting duplicate non-null keys. That is exactly what the
 * architecture wants — a stable external id is unique when the source
 * provides one, and fuzzy CSV rows without one are never blocked (two
 * legitimate identical purchases stay distinct; see Issue 4.11).
 */
export const dataSources = pgTable(
  "data_sources",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Ingestion origin kind: `csv_file`, `xlsx_file`, or `manual`. */
    type: text("type").notNull(),
    /** Human provider label, e.g. `Revolut CSV`. Null for manual sources. */
    provider: text("provider"),
    /** User-visible name, e.g. `Revolut CSV`. */
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    check("data_sources_status_check", sql`${t.status} in ('active', 'archived', 'disconnected')`),
    index("data_sources_workspace_status_idx").on(t.workspaceId, t.status),
    index("data_sources_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export type DataSource = typeof dataSources.$inferSelect;
export type NewDataSource = typeof dataSources.$inferInsert;

export const imports = pgTable(
  "imports",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    dataSourceId: uuid("data_source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "cascade" }),
    /** Caller key making re-submits idempotent per workspace (Issue 3.6). */
    idempotencyKey: text("idempotency_key").notNull(),
    fileName: text("file_name"),
    /** SHA-256 of the raw bytes. Warning signal only, never a unique key. */
    fileSha256: text("file_sha256"),
    /** Private quarantine object key. Never a public URL (Issue 3.2). */
    objectStorageKey: text("object_storage_key"),
    parserVersion: text("parser_version").notNull().default("v1"),
    status: text("status").notNull().default("pending"),
    rowCount: integer("row_count"),
    newCount: integer("new_count"),
    duplicateCount: integer("duplicate_count"),
    reviewCount: integer("review_count"),
    errorCount: integer("error_count"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("imports_workspace_idempotency_uniq").on(t.workspaceId, t.idempotencyKey),
    check(
      "imports_status_check",
      sql`${t.status} in ('pending', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    index("imports_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("imports_data_source_idx").on(t.dataSourceId),
  ],
);

export type StatementImport = typeof imports.$inferSelect;
export type NewStatementImport = typeof imports.$inferInsert;

export const sourceAccounts = pgTable(
  "source_accounts",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    dataSourceId: uuid("data_source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "cascade" }),
    /** Stable source key when the origin guarantees one; else null (no fuzzy unique). */
    externalId: text("external_id"),
    stableSourceKey: text("stable_source_key"),
    displayName: text("display_name"),
    officialName: text("official_name"),
    currencyCode: text("currency_code"),
    rawType: text("raw_type"),
    rawSubtype: text("raw_subtype"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    // NULL-exempt by PG semantics: many keyless CSV accounts coexist, but a
    // repeated stable external id collides loudly.
    unique("source_accounts_source_external_uniq").on(t.dataSourceId, t.externalId),
    unique("source_accounts_source_stable_uniq").on(t.dataSourceId, t.stableSourceKey),
    index("source_accounts_workspace_created_idx").on(t.workspaceId, t.firstSeenAt),
    index("source_accounts_data_source_idx").on(t.dataSourceId),
  ],
);

export type SourceAccount = typeof sourceAccounts.$inferSelect;
export type NewSourceAccount = typeof sourceAccounts.$inferInsert;

export const sourceTransactions = pgTable(
  "source_transactions",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    dataSourceId: uuid("data_source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "cascade" }),
    sourceAccountId: uuid("source_account_id").references(() => sourceAccounts.id, {
      onDelete: "set null",
    }),
    /** Stable source key when guaranteed; else null. Never a fuzzy unique. */
    externalId: text("external_id"),
    stableSourceKey: text("stable_source_key"),
    currentStatus: text("current_status").notNull().default("observed"),
    /** Logical link for pending/matched pairs (Issue 4.11 resolves these). */
    pendingSourceTransactionId: uuid("pending_source_transaction_id"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    /** Newest observation id (app-maintained, no FK to avoid a DDL cycle). */
    latestObservationId: uuid("latest_observation_id"),
  },
  (t) => [
    unique("source_transactions_source_external_uniq").on(t.dataSourceId, t.externalId),
    unique("source_transactions_source_stable_uniq").on(t.dataSourceId, t.stableSourceKey),
    check(
      "source_transactions_status_check",
      sql`${t.currentStatus} in ('observed', 'pending_review', 'matched', 'removed')`,
    ),
    index("source_transactions_workspace_created_idx").on(t.workspaceId, t.firstSeenAt),
    index("source_transactions_account_idx").on(t.sourceAccountId),
    index("source_transactions_data_source_idx").on(t.dataSourceId),
  ],
);

export type SourceTransaction = typeof sourceTransactions.$inferSelect;
export type NewSourceTransaction = typeof sourceTransactions.$inferInsert;

export const sourceTransactionObservations = pgTable(
  "source_transaction_observations",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceTransactionId: uuid("source_transaction_id")
      .notNull()
      .references(() => sourceTransactions.id, { onDelete: "cascade" }),
    importId: uuid("import_id").references(() => imports.id, { onDelete: "set null" }),
    rowNumber: integer("row_number"),
    observationType: text("observation_type").notNull().default("file_row"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    /** SHA-256 over the canonicalized raw row (dedupe hint, not identity). */
    rawHash: text("raw_hash").notNull(),
    /** Exact source payload as parsed (never normalized away). */
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    // One observation per (import, row). NULL import/row rows (manual notes)
    // are exempt by PG NULL semantics.
    unique("source_observations_import_row_uniq").on(t.importId, t.rowNumber),
    check("source_observations_type_check", sql`${t.observationType} in ('file_row', 'manual')`),
    index("source_observations_transaction_observed_idx").on(t.sourceTransactionId, t.observedAt),
    index("source_observations_import_row_idx").on(t.importId, t.rowNumber),
  ],
);

export type SourceTransactionObservation = typeof sourceTransactionObservations.$inferSelect;
export type NewSourceTransactionObservation = typeof sourceTransactionObservations.$inferInsert;

/**
 * Epoch 4, Issue 4.1 — canonical account model.
 *
 * User-facing accounts derived from source observations (via
 * `account_source_links`; Issue 4.3 canonicalization) WITHOUT deleting the
 * raw source rows. `account_balance_snapshots` are insert-only: the newest
 * `observed_at` row wins (Issue 4.10 supersedes, never updates). NULL
 * amounts mean unknown, never zero.
 *
 * Ordinary product use archives (`archived_at`); hard deletes only happen
 * through workspace removal. `version` columns arrive in Epoch 5 (Issue 5.2);
 * until then concurrency rides on command idempotency + snapshot supersede.
 */
export type AccountType =
  | "CHECKING"
  | "SAVINGS"
  | "CASH"
  | "CREDIT"
  | "INVESTMENT"
  | "WALLET"
  | "OTHER";

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    institutionName: text("institution_name"),
    accountType: text("account_type").notNull().default("OTHER"),
    currencyCode: text("currency_code").notNull().default("EUR"),
    isSpendable: boolean("is_spendable").notNull().default(true),
    includeInNetWorth: boolean("include_in_net_worth").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "accounts_type_check",
      sql`${t.accountType} in ('CHECKING', 'SAVINGS', 'CASH', 'CREDIT', 'INVESTMENT', 'WALLET', 'OTHER')`,
    ),
    index("accounts_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export type AccountSourceLinkRelationship = "PRIMARY" | "MERGED" | "OTHER";

export const accountSourceLinks = pgTable(
  "account_source_links",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sourceAccountId: uuid("source_account_id")
      .notNull()
      .references(() => sourceAccounts.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull().default("PRIMARY"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.sourceAccountId] }),
    check(
      "account_source_links_relationship_check",
      sql`${t.relationship} in ('PRIMARY', 'MERGED', 'OTHER')`,
    ),
    index("account_source_links_source_idx").on(t.sourceAccountId),
  ],
);

export type AccountSourceLink = typeof accountSourceLinks.$inferSelect;
export type NewAccountSourceLink = typeof accountSourceLinks.$inferInsert;

export type BalanceSnapshotSource = "statement" | "manual" | "imported" | "other";

export const accountBalanceSnapshots = pgTable(
  "account_balance_snapshots",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    /** NULL = unknown, never zero (Issue 4.10). */
    currentAmountMinor: bigint("current_amount_minor", { mode: "number" }),
    availableAmountMinor: bigint("available_amount_minor", { mode: "number" }),
    creditLimitMinor: bigint("credit_limit_minor", { mode: "number" }),
    currencyCode: text("currency_code").notNull(),
    source: text("source").notNull().default("manual"),
    sourceImportId: uuid("source_import_id").references(() => imports.id, {
      onDelete: "set null",
    }),
    freshness: text("freshness"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "account_balance_snapshots_source_check",
      sql`${t.source} in ('statement', 'manual', 'imported', 'other')`,
    ),
    index("account_balance_snapshots_account_observed_idx").on(t.accountId, t.observedAt),
    index("account_balance_snapshots_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export type AccountBalanceSnapshot = typeof accountBalanceSnapshots.$inferSelect;
export type NewAccountBalanceSnapshot = typeof accountBalanceSnapshots.$inferInsert;
