/**
 * Issue 2.2 — idempotent command executor.
 *
 * Every canonical mutation runs this lifecycle, in order:
 *
 *   authorize -> claim idempotency -> load state -> check expected version ->
 *   validate invariant -> mutate -> increment version -> audit -> outbox ->
 *   store command result -> commit
 *
 * The store interface is injected so this lifecycle is testable without
 * PostgreSQL and reusable by every domain command (Epoch 4+ provides the
 * Drizzle-backed store over `command_operations` / `audit_events` /
 * `outbox_events` from Issue 2.1). `createMemoryCommandStore` is the
 * simplest in-memory store: same semantics, no I/O.
 */

export type CommandErrorCode =
  | "FORBIDDEN"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED"
  | "INVARIANT_VIOLATION"
  | "UNDO_CONFLICT";

export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: CommandErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.details = details;
  }
}

export interface CommandContext {
  workspaceId: string;
  actorUserId: string | null;
  /** Client-supplied idempotency key, scoped per command name. */
  idempotencyKey: string;
  /** Optimistic-concurrency guard, when the command targets a versioned entity. */
  expectedVersion?: number | null;
}

export interface CommandAuditRecord {
  entityType: string;
  entityId: string;
  action: string;
  reason?: string | null;
  relatedAiRunId?: string | null;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
}

export interface CommandOutboxRecord {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

export interface CommandMutation<Result> {
  resultingVersion: number;
  result: Result;
  audit: CommandAuditRecord;
  outbox?: CommandOutboxRecord[];
}

export interface CommandDefinition<State, Input, Result> {
  readonly name: string;
  /** Step 1: throw CommandError(FORBIDDEN) when the actor may not run this. */
  authorize(ctx: CommandContext, input: Input): void | Promise<void>;
  /** Step 3: read the entity the command will change. */
  loadState(ctx: CommandContext, input: Input): State | Promise<State>;
  /** Current version of the loaded entity (undefined = unversioned). */
  currentVersionOf(state: State): number | null | undefined;
  /** Step 5: domain invariant over loaded state + input. Throw on violation. */
  checkInvariant?(state: State, input: Input): void | Promise<void>;
  /** Step 6+7: pure mutation. Must not touch the store; the executor persists. */
  mutate(state: State, input: Input): CommandMutation<Result> | Promise<CommandMutation<Result>>;
}

export interface StoredClaim {
  status: "claimed" | "succeeded" | "failed";
  inputHash: string;
  /** The exact mutation result (the Drizzle store persists this as JSON). */
  result: unknown;
  resultingVersion: number | null;
}

export interface CommandStore {
  /**
   * Steps 2 + 10 + 11: run `fn` atomically. `claim` inserts the idempotency
   * row (UNIQUE(workspace_id, command_name, idempotency_key) in Postgres);
   * it returns the LATEST stored claim for the key, or null when this call
   * is the first claimant. `commit` persists audit/outbox/result together.
   */
  withClaim<R>(
    workspaceId: string,
    commandName: string,
    idempotencyKey: string,
    inputHash: string,
    fn: (existing: StoredClaim | null) => Promise<R>,
  ): Promise<R>;
  readClaim(
    workspaceId: string,
    commandName: string,
    idempotencyKey: string,
  ): Promise<StoredClaim | null>;
  commitSuccess(
    workspaceId: string,
    commandName: string,
    idempotencyKey: string,
    commit: {
      actorUserId: string | null;
      resultingVersion: number | null;
      /** Stored verbatim and returned verbatim on replay. */
      result: unknown;
      audit: CommandAuditRecord & { commandOperationId: string };
      outbox: CommandOutboxRecord[];
    },
  ): Promise<string>;
  commitFailure(workspaceId: string, commandName: string, idempotencyKey: string): Promise<void>;
}

export interface CommandOutcome<Result> {
  result: Result;
  resultingVersion: number | null;
  operationId: string;
  /** True when this call replayed a previous execution (no re-mutation). */
  replayed: boolean;
}

/** Stable hash of the command input: same key + same input = replay, different input = reuse error. */
export function hashInput(input: unknown): string {
  return JSON.stringify(input ?? null);
}

/**
 * Run one typed domain command through the full lifecycle. Replays never
 * re-run `mutate`: they return the stored result verbatim.
 */
export async function executeCommand<State, Input, Result>(
  def: CommandDefinition<State, Input, Result>,
  ctx: CommandContext,
  input: Input,
  store: CommandStore,
): Promise<CommandOutcome<Result>> {
  if (!ctx.workspaceId) {
    throw new CommandError("FORBIDDEN", "workspace context is required");
  }
  if (!ctx.idempotencyKey) {
    throw new CommandError("INVARIANT_VIOLATION", "idempotencyKey is required");
  }

  // Step 1 — authorize (before touching stored state, so denials leave nothing).
  await def.authorize(ctx, input);

  const inputHash = hashInput(input);

  return store.withClaim(
    ctx.workspaceId,
    def.name,
    ctx.idempotencyKey,
    inputHash,
    async (existing) => {
      // Step 2 — claim idempotency.
      if (existing?.status === "succeeded") {
        if (existing.inputHash !== inputHash) {
          // Same key, different payload: almost certainly a client bug that
          // would silently do the wrong thing — reject loudly (Issue 2.3 code).
          throw new CommandError(
            "IDEMPOTENCY_KEY_REUSED",
            `idempotency key "${ctx.idempotencyKey}" was already used for ${def.name} with different input`,
            { commandName: def.name },
          );
        }
        return {
          result: (existing.result ?? {}) as Result,
          resultingVersion: existing.resultingVersion,
          operationId: `${ctx.workspaceId}:${def.name}:${ctx.idempotencyKey}`,
          replayed: true,
        };
      }

      try {
        // Step 3 — load state.
        const state = await def.loadState(ctx, input);

        // Step 4 — check expected version (optimistic concurrency).
        const current = def.currentVersionOf(state);
        if (
          ctx.expectedVersion !== undefined &&
          ctx.expectedVersion !== null &&
          current !== undefined &&
          current !== null &&
          ctx.expectedVersion !== current
        ) {
          throw new CommandError(
            "VERSION_CONFLICT",
            `stale version: expected ${ctx.expectedVersion}, current ${current}`,
            { expectedVersion: ctx.expectedVersion, currentVersion: current },
          );
        }

        // Step 5 — validate invariant.
        await def.checkInvariant?.(state, input);

        // Steps 6 + 7 — mutate + increment version (the definition returns the
        // post-mutation version; the executor never invents one).
        const mutation = await def.mutate(state, input);

        // Steps 8 + 9 + 10 — audit + outbox + store command result, atomically.
        // The result is stored verbatim so replays return exactly what the
        // first execution returned (the Drizzle store JSON-encodes it; scalar
        // results are wrapped there with an explicit marker).
        const operationId = await store.commitSuccess(
          ctx.workspaceId,
          def.name,
          ctx.idempotencyKey,
          {
            actorUserId: ctx.actorUserId,
            resultingVersion: mutation.resultingVersion,
            result: mutation.result,
            audit: { ...mutation.audit, commandOperationId: "" },
            outbox: mutation.outbox ?? [],
          },
        );

        // Step 11 — commit happens inside the store; reaching here means commit.
        return {
          result: mutation.result,
          resultingVersion: mutation.resultingVersion,
          operationId,
          replayed: false,
        };
      } catch (error) {
        await store.commitFailure(ctx.workspaceId, def.name, ctx.idempotencyKey);
        throw error;
      }
    },
  );
}

/** Operation id format, shared with the Drizzle store (Epoch 4+) and tests. */
export function operationIdFor(workspaceId: string, commandName: string, key: string): string {
  return `${workspaceId}:${commandName}:${key}`;
}

interface MemoryClaim extends StoredClaim {
  workspaceId: string;
  commandName: string;
  idempotencyKey: string;
  actorUserId: string | null;
  audit: (CommandAuditRecord & { commandOperationId: string })[];
  outbox: CommandOutboxRecord[];
}

/**
 * Simplest durable-semantics store: a Map keyed by
 * `workspaceId:commandName:idempotencyKey`. `withClaim` runs the callback
 * synchronously (single-threaded atomicity); the Drizzle store replaces this
 * with a real transaction + UNIQUE insert in later epochs.
 */
export function createMemoryCommandStore() {
  const claims = new Map<string, MemoryClaim>();
  const keyOf = (w: string, c: string, k: string) => `${w}:${c}:${k}`;

  const store: CommandStore & {
    claims(): readonly MemoryClaim[];
    audit(): readonly (CommandAuditRecord & { commandOperationId: string })[];
    outbox(): readonly CommandOutboxRecord[];
  } = {
    async withClaim<R>(
      workspaceId: string,
      commandName: string,
      idempotencyKey: string,
      inputHash: string,
      fn: (existing: StoredClaim | null) => Promise<R>,
    ): Promise<R> {
      const key = keyOf(workspaceId, commandName, idempotencyKey);
      const existing = claims.get(key) ?? null;
      if (existing === null) {
        claims.set(key, {
          workspaceId,
          commandName,
          idempotencyKey,
          status: "claimed",
          inputHash,
          result: null,
          resultingVersion: null,
          actorUserId: null,
          audit: [],
          outbox: [],
        });
        return fn(null);
      }
      return fn({ ...existing });
    },
    readClaim(workspaceId: string, commandName: string, idempotencyKey: string) {
      const existing = claims.get(keyOf(workspaceId, commandName, idempotencyKey));
      return Promise.resolve<StoredClaim | null>(existing ? { ...existing } : null);
    },
    commitSuccess(
      workspaceId: string,
      commandName: string,
      idempotencyKey: string,
      commit: {
        actorUserId: string | null;
        resultingVersion: number | null;
        result: unknown;
        audit: CommandAuditRecord & { commandOperationId: string };
        outbox: CommandOutboxRecord[];
      },
    ) {
      const key = keyOf(workspaceId, commandName, idempotencyKey);
      const claim = claims.get(key);
      if (!claim) {
        return Promise.reject(new Error(`commitSuccess without claim for ${key}`));
      }
      const operationId = operationIdFor(workspaceId, commandName, idempotencyKey);
      claim.status = "succeeded";
      claim.actorUserId = commit.actorUserId;
      claim.resultingVersion = commit.resultingVersion;
      claim.result = commit.result;
      claim.audit = [{ ...commit.audit, commandOperationId: operationId }];
      claim.outbox = [...commit.outbox];
      return Promise.resolve(operationId);
    },
    commitFailure(workspaceId: string, commandName: string, idempotencyKey: string) {
      const claim = claims.get(keyOf(workspaceId, commandName, idempotencyKey));
      if (claim && claim.status === "claimed") {
        claim.status = "failed";
      }
      return Promise.resolve();
    },
    claims: () => [...claims.values()],
    audit: () => [...claims.values()].flatMap((c) => c.audit),
    outbox: () => [...claims.values()].flatMap((c) => c.outbox),
  };
  return store;
}
