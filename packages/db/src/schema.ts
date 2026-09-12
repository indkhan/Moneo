import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
