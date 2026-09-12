import { sql } from "drizzle-orm";
import {
  bigint,
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
  (t) => [
    index("security_audit_events_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
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
