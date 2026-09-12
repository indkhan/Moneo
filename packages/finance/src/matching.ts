import { DomainError } from "@moneo/shared/problem";
import {
  canonicalizeRow,
  createMemoryCanonicalizeStore,
  toCanonicalFields,
  type CanonicalizeInput,
  type CanonicalizeStore,
} from "./canonicalize.js";
import { normalizeHeader } from "./mapping.js";
import { CommandError, type CommandDefinition, type CommandMutation } from "./commands.js";

/**
 * Issue 4.11 — overlapping import matching and resolution (pure domain).
 *
 * Trust ladder per row, in order:
 *
 * 1. Identity: the source row is already canonicalized (retry or same
 *    import re-run) → `matched`, no new effect.
 * 2. Trusted external identity (`trusted-external-id`): a stable source key
 *    the origin guarantees (bank feed IDs — file rows rarely carry one)
 *    points at an already-canonicalized source row → MERGED link onto the
 *    same canonical transaction, recorded with rule + version. No fuzzy
 *    guessing is ever trusted.
 * 3. Conservative fuzzy (`fuzzy-date-amount-description`): same date,
 *    amount, and currency plus a normalized-description equality stages one
 *    `pending` candidate per near-match. Pending rows stay OUTSIDE accepted
 *    canonical totals until `matches.resolve` links or keeps them distinct.
 *    An unspecified format defaults to review — never to auto-link.
 * 4. Otherwise the row is confidently new → canonicalized (`accepted`).
 *
 * Multiplicity is preserved structurally: candidates are pair rows, never a
 * fuzzy uniqueness constraint, so two legitimate identical purchases stay
 * distinct and one accepted row can never absorb new rows automatically.
 * Linking preserves prior canonical corrections — resolution only inserts
 * links (and, for keep-distinct, a new canonical row), never edits the
 * existing canonical fields.
 */

export const MATCH_VERSION = "v1";
/** Bounded near-match lookup per row: review stays triageable on big files. */
export const MATCH_LOOKUP_LIMIT = 10;

export type MatchDisposition = "accepted" | "matched" | "pending";
export type MatchRule = "trusted-external-id" | "fuzzy-date-amount-description";

export interface FuzzyTransaction {
  transactionId: string;
  description: string;
}

export interface MatchRowInput extends CanonicalizeInput {
  importId: string;
  externalId?: string | null;
  stableSourceKey?: string | null;
}

export interface MatchOutcome {
  disposition: MatchDisposition;
  accountId: string;
  /** Null while pending: no canonical row exists yet. */
  transactionId: string | null;
  candidateIds: string[];
}

export interface MatchStore extends CanonicalizeStore {
  findTrustedSource(input: {
    dataSourceId: string;
    externalId: string | null;
    stableSourceKey: string | null;
  }): Promise<{ sourceTransactionId: string } | null>;
  findFuzzyTransactions(filter: {
    workspaceId: string;
    effectiveDate: string;
    amountMinor: string;
    currencyCode: string;
    limit?: number;
  }): Promise<FuzzyTransaction[]>;
  linkMerged(input: {
    workspaceId: string;
    transactionId: string;
    sourceTransactionId: string;
  }): Promise<{ created: boolean }>;
  stageCandidate(candidate: {
    workspaceId: string;
    importId: string;
    dataSourceId: string;
    sourceTransactionId: string;
    candidateTransactionId: string;
    matchRule: MatchRule;
    confidence: "auto" | "review";
    status: "pending" | "linked";
    detail: Record<string, unknown>;
  }): Promise<{ id: string; created: boolean }>;
}

/** Same normalization as column detection: case/diacritic/punctuation blind. */
export function normalizeMatchDescription(description: string): string {
  return normalizeHeader(description);
}

function invalid(message: string): DomainError {
  return new DomainError("VALIDATION_FAILED", {
    detail: message,
    errors: [{ field: "match", message }],
  });
}

function stagedDetail(input: MatchRowInput): Record<string, unknown> {
  return {
    date: input.row.date,
    description: input.row.description,
    amountMinor: input.row.amountMinor,
    currencyCode: input.row.currency,
    direction: input.row.direction,
    account: input.row.account,
    sourceAccountLabel: input.sourceAccountLabel ?? null,
    sourceAccountId: input.sourceAccountId,
  };
}

/**
 * Decide one imported row: match, stage, or accept. Throws DomainError on
 * bad DATA (the caller counts a rejected row, never retries it).
 *
 * The canonical account is ensured first: one account per source account
 * regardless of how its rows dispose, so every outcome carries an account.
 */
export async function decideRowForImport(
  store: MatchStore,
  input: MatchRowInput,
): Promise<MatchOutcome> {
  const fields = toCanonicalFields(input.row);
  if (!input.workspaceId || !input.dataSourceId || !input.importId) {
    throw invalid("Match input needs workspaceId, dataSourceId, and importId.");
  }

  let accountId = await store.findAccountIdBySource(input.sourceAccountId);
  if (accountId === null) {
    const label =
      input.row.account?.trim() || input.sourceAccountLabel?.trim() || "Imported account";
    const created = await store.createAccount({
      workspaceId: input.workspaceId,
      name: label,
      currencyCode: fields.currencyCode,
    });
    await store.linkAccount({
      workspaceId: input.workspaceId,
      accountId: created.id,
      sourceAccountId: input.sourceAccountId,
    });
    accountId = created.id;
  }

  // 1. Identity: already canonicalized (retry / same-row re-import).
  const existing = await store.findTransactionIdBySource(input.sourceTransactionId);
  if (existing !== null) {
    return { disposition: "matched", accountId, transactionId: existing, candidateIds: [] };
  }

  // 2. Trusted external identity — only when the origin guarantees a key.
  const externalId = input.externalId ?? null;
  const stableSourceKey = input.stableSourceKey ?? null;
  if (externalId !== null || stableSourceKey !== null) {
    const trusted = await store.findTrustedSource({
      dataSourceId: input.dataSourceId,
      externalId,
      stableSourceKey,
    });
    if (trusted && trusted.sourceTransactionId !== input.sourceTransactionId) {
      const canonical = await store.findTransactionIdBySource(trusted.sourceTransactionId);
      if (canonical !== null) {
        await store.linkMerged({
          workspaceId: input.workspaceId,
          transactionId: canonical,
          sourceTransactionId: input.sourceTransactionId,
        });
        const staged = await store.stageCandidate({
          workspaceId: input.workspaceId,
          importId: input.importId,
          dataSourceId: input.dataSourceId,
          sourceTransactionId: input.sourceTransactionId,
          candidateTransactionId: canonical,
          matchRule: "trusted-external-id",
          confidence: "auto",
          status: "linked",
          detail: { ...stagedDetail(input), matchVersion: MATCH_VERSION },
        });
        return {
          disposition: "matched",
          accountId,
          transactionId: canonical,
          candidateIds: [staged.id],
        };
      }
    }
  }

  // 3. Conservative fuzzy: stage every near-match for review, link nothing.
  const near = await store.findFuzzyTransactions({
    workspaceId: input.workspaceId,
    effectiveDate: fields.effectiveDate,
    amountMinor: fields.amountMinor,
    currencyCode: fields.currencyCode,
    limit: MATCH_LOOKUP_LIMIT,
  });
  const wanted = normalizeMatchDescription(fields.description);
  const candidateIds: string[] = [];
  for (const row of near) {
    if (normalizeMatchDescription(row.description) !== wanted) {
      continue;
    }
    const staged = await store.stageCandidate({
      workspaceId: input.workspaceId,
      importId: input.importId,
      dataSourceId: input.dataSourceId,
      sourceTransactionId: input.sourceTransactionId,
      candidateTransactionId: row.transactionId,
      matchRule: "fuzzy-date-amount-description",
      confidence: "review",
      status: "pending",
      detail: { ...stagedDetail(input), matchVersion: MATCH_VERSION },
    });
    candidateIds.push(staged.id);
  }
  if (candidateIds.length > 0) {
    return { disposition: "pending", accountId, transactionId: null, candidateIds };
  }

  // 4. Confidently new.
  const canonicalized = await canonicalizeRow(store, input);
  return {
    disposition: "accepted",
    accountId: canonicalized.accountId,
    transactionId: canonicalized.transactionId,
    candidateIds: [],
  };
}

export interface ResolveCandidate {
  id: string;
  status: "pending" | "linked" | "distinct";
  importId: string;
  dataSourceId: string;
  sourceTransactionId: string;
  candidateTransactionId: string;
  detail: Record<string, unknown>;
}

export interface ResolveStore extends CanonicalizeStore {
  findCandidate(workspaceId: string, candidateId: string): Promise<ResolveCandidate | null>;
  findCanonicalTransaction(
    workspaceId: string,
    transactionId: string,
  ): Promise<{ id: string } | null>;
  linkMerged(input: {
    workspaceId: string;
    transactionId: string;
    sourceTransactionId: string;
  }): Promise<{ created: boolean }>;
  markCandidate(
    workspaceId: string,
    candidateId: string,
    status: "linked" | "distinct",
  ): Promise<void>;
}

export interface ResolveMatchInput {
  candidateId: string;
  decision: "link" | "distinct";
}

export interface ResolveMatchResult {
  candidateId: string;
  decision: "link" | "distinct";
  transactionId: string;
  /** True when the decision was already recorded (retry convergence). */
  duplicate: boolean;
}

interface LoadedMatch {
  workspaceId: string;
  candidate: ResolveCandidate | null;
  canonicalExists: boolean;
  alreadyLinked: boolean;
}

function candidateFields(detail: Record<string, unknown>): {
  row: {
    rowNumber: number;
    date: string;
    description: string;
    amountMinor: string;
    currency: string;
    direction: "credit" | "debit";
    account: string | null;
  };
  sourceAccountId: string;
  sourceAccountLabel: string | null;
} {
  const get = (key: string): unknown => detail[key];
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const rawDirection = get("direction");
  // A corrupt stage fails closed here, never as a mis-signed transaction.
  if (rawDirection !== "credit" && rawDirection !== "debit") {
    throw new CommandError("INVARIANT_VIOLATION", "Staged row lost its direction.");
  }
  const row: {
    rowNumber: number;
    date: string;
    description: string;
    amountMinor: string;
    currency: string;
    direction: "credit" | "debit";
    account: string | null;
  } = {
    rowNumber: 0,
    date: str(get("date")),
    description: str(get("description")),
    amountMinor: str(get("amountMinor")),
    currency: str(get("currencyCode")),
    direction: rawDirection,
    account: str(get("account")) === "" ? null : str(get("account")),
  };
  // Re-validates the staged snapshot: a corrupt stage fails closed here.
  toCanonicalFields(row);
  const rawAccountId = get("sourceAccountId");
  return {
    row,
    sourceAccountId: typeof rawAccountId === "string" ? rawAccountId : "",
    sourceAccountLabel:
      str(get("sourceAccountLabel")) === "" ? null : str(get("sourceAccountLabel")),
  };
}

/** `matches.resolve`: audited link-to-existing or keep-as-distinct. */
export function createResolveMatchCommand(
  data: ResolveStore,
): CommandDefinition<LoadedMatch, ResolveMatchInput, ResolveMatchResult> {
  return {
    name: "matches.resolve",
    authorize: () => {},
    async loadState(ctx, input) {
      const candidate = await data.findCandidate(ctx.workspaceId, input.candidateId);
      if (!candidate) {
        return {
          workspaceId: ctx.workspaceId,
          candidate: null,
          canonicalExists: false,
          alreadyLinked: false,
        };
      }
      const canonicalExists =
        (await data.findCanonicalTransaction(ctx.workspaceId, candidate.candidateTransactionId)) !==
        null;
      const alreadyLinked =
        (await data.findTransactionIdBySource(candidate.sourceTransactionId)) !== null;
      return { workspaceId: ctx.workspaceId, candidate, canonicalExists, alreadyLinked };
    },
    currentVersionOf: () => null,
    checkInvariant(state, input) {
      if (!state.candidate) {
        throw new CommandError("FORBIDDEN", "Match candidate not found in this workspace.");
      }
      if (state.candidate.status !== "pending") {
        throw new CommandError(
          "INVARIANT_VIOLATION",
          `Match candidate is already ${state.candidate.status}; resolve it once.`,
        );
      }
      // Runtime validation over a plain string: forged decisions fail closed.
      const decision: string = input.decision;
      if (decision !== "link" && decision !== "distinct") {
        throw new CommandError("INVARIANT_VIOLATION", `Unknown decision: ${decision}.`);
      }
      if (decision === "link" && !state.canonicalExists) {
        throw new CommandError(
          "INVARIANT_VIOLATION",
          "The matched transaction no longer exists; keep the row distinct instead.",
        );
      }
    },
    async mutate(state, input) {
      const candidate = state.candidate;
      if (!candidate) {
        throw new CommandError("FORBIDDEN", "Match candidate not found in this workspace.");
      }
      if (input.decision === "link") {
        const linked = await data.linkMerged({
          workspaceId: state.workspaceId,
          transactionId: candidate.candidateTransactionId,
          sourceTransactionId: candidate.sourceTransactionId,
        });
        await data.markCandidate(state.workspaceId, candidate.id, "linked");
        return linkOrDistinctMutation(
          candidate,
          "link",
          candidate.candidateTransactionId,
          !linked.created,
        );
      }
      const staged = candidateFields(candidate.detail);
      if (!staged.sourceAccountId) {
        throw new CommandError("INVARIANT_VIOLATION", "Staged row lost its source account.");
      }
      let accountId = await data.findAccountIdBySource(staged.sourceAccountId);
      if (accountId === null) {
        const created = await data.createAccount({
          workspaceId: state.workspaceId,
          name:
            staged.row.account?.trim() || staged.sourceAccountLabel?.trim() || "Imported account",
          currencyCode: staged.row.currency,
        });
        await data.linkAccount({
          workspaceId: state.workspaceId,
          accountId: created.id,
          sourceAccountId: staged.sourceAccountId,
        });
        accountId = created.id;
      }
      const converged = await data.findTransactionIdBySource(candidate.sourceTransactionId);
      let transactionId = converged;
      let duplicate = converged !== null;
      if (transactionId === null) {
        const created = await data.createTransaction({
          workspaceId: state.workspaceId,
          accountId,
          direction: staged.row.direction,
          amountMinor: staged.row.amountMinor,
          currencyCode: staged.row.currency,
          effectiveDate: staged.row.date,
          description: staged.row.description,
        });
        await data.linkTransaction({
          workspaceId: state.workspaceId,
          transactionId: created.id,
          sourceTransactionId: candidate.sourceTransactionId,
        });
        transactionId = created.id;
        duplicate = false;
      }
      await data.markCandidate(state.workspaceId, candidate.id, "distinct");
      return linkOrDistinctMutation(candidate, "distinct", transactionId, duplicate);
    },
  };
}

function linkOrDistinctMutation(
  candidate: ResolveCandidate,
  decision: "link" | "distinct",
  transactionId: string,
  duplicate: boolean,
): CommandMutation<ResolveMatchResult> {
  return {
    resultingVersion: 0,
    result: { candidateId: candidate.id, decision, transactionId, duplicate },
    audit: {
      entityType: "transaction",
      entityId: transactionId,
      action: "matches.resolve",
      oldValue: { candidateId: candidate.id, status: "pending" },
      newValue: {
        candidateId: candidate.id,
        status: decision === "link" ? "linked" : "distinct",
        transactionId,
      },
    },
    outbox: [
      {
        aggregateType: "transaction",
        aggregateId: transactionId,
        eventType: "match.resolved",
        payload: { candidateId: candidate.id, decision, transactionId },
      },
    ],
  };
}

interface MemoryTransaction {
  id: string;
  workspaceId: string;
  effectiveDate: string;
  amountMinor: string;
  currencyCode: string;
  description: string;
}

interface MemoryIdentity {
  dataSourceId: string;
  externalId: string | null;
  stableSourceKey: string | null;
  canonicalId: string | null;
}

interface MemoryCandidate {
  id: string;
  workspaceId: string;
  importId: string;
  dataSourceId: string;
  sourceTransactionId: string;
  candidateTransactionId: string;
  matchRule: MatchRule;
  confidence: "auto" | "review";
  status: "pending" | "linked" | "distinct";
  detail: Record<string, unknown>;
}

export interface SeedCanonicalInput {
  workspaceId: string;
  dataSourceId: string;
  sourceTransactionId: string;
  externalId?: string | null;
  stableSourceKey?: string | null;
  effectiveDate: string;
  amountMinor: string;
  currencyCode: string;
  description: string;
  direction?: "credit" | "debit";
}

/**
 * In-memory match store: lookup-first idempotency plus staged candidates,
 * the same semantics the Drizzle store keeps. Canonical identity comes from
 * the 4.3 memory store underneath; source identities (for trusted lookup)
 * are registered explicitly via `seedCanonical` in tests — file rows carry
 * no stable keys, so production file imports exercise the fuzzy path.
 */
export function createMemoryMatchStore(): MatchStore &
  ResolveStore & {
    transactions(): MemoryTransaction[];
    candidates(): MemoryCandidate[];
    seedCanonical(input: SeedCanonicalInput): Promise<{ transactionId: string }>;
  } {
  const base = createMemoryCanonicalizeStore();
  const txnFields = new Map<string, MemoryTransaction>();
  const identities = new Map<string, MemoryIdentity>();
  const merged = new Set<string>();
  const candidates = new Map<string, MemoryCandidate>();
  let ids = 1000;
  const nextId = (prefix: string): string => `${prefix}-${(ids += 1)}`;

  const store: MatchStore &
    ResolveStore & {
      transactions(): MemoryTransaction[];
      candidates(): MemoryCandidate[];
      seedCanonical(input: SeedCanonicalInput): Promise<{ transactionId: string }>;
    } = {
    ...base,
    transactions: () => [...txnFields.values()],
    candidates: () => [...candidates.values()],

    // Sees merged links too (base only knows PRIMARY links).
    findTransactionIdBySource: async (sourceTransactionId) =>
      identities.get(sourceTransactionId)?.canonicalId ??
      base.findTransactionIdBySource(sourceTransactionId),

    seedCanonical: async (input) => {
      const account = await base.createAccount({
        workspaceId: input.workspaceId,
        name: "Seed account",
        currencyCode: input.currencyCode,
      });
      const created = await base.createTransaction({
        workspaceId: input.workspaceId,
        accountId: account.id,
        direction: input.direction ?? "debit",
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        effectiveDate: input.effectiveDate,
        description: input.description,
      });
      await base.linkTransaction({
        workspaceId: input.workspaceId,
        transactionId: created.id,
        sourceTransactionId: input.sourceTransactionId,
      });
      txnFields.set(created.id, {
        id: created.id,
        workspaceId: input.workspaceId,
        effectiveDate: input.effectiveDate,
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        description: input.description,
      });
      identities.set(input.sourceTransactionId, {
        dataSourceId: input.dataSourceId,
        externalId: input.externalId ?? null,
        stableSourceKey: input.stableSourceKey ?? null,
        canonicalId: created.id,
      });
      return { transactionId: created.id };
    },

    createTransaction: async (input) => {
      const created = await base.createTransaction(input);
      txnFields.set(created.id, {
        id: created.id,
        workspaceId: input.workspaceId,
        effectiveDate: input.effectiveDate,
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        description: input.description,
      });
      return created;
    },

    linkTransaction: async (input) => {
      await base.linkTransaction(input);
      const identity = identities.get(input.sourceTransactionId);
      if (identity) {
        identities.set(input.sourceTransactionId, {
          ...identity,
          canonicalId: input.transactionId,
        });
      } else {
        identities.set(input.sourceTransactionId, {
          dataSourceId: "",
          externalId: null,
          stableSourceKey: null,
          canonicalId: input.transactionId,
        });
      }
    },

    findTrustedSource: ({ dataSourceId, externalId, stableSourceKey }) => {
      for (const [sourceTransactionId, identity] of identities) {
        if (identity.dataSourceId !== dataSourceId || identity.canonicalId === null) {
          continue;
        }
        if (externalId !== null && identity.externalId === externalId) {
          return Promise.resolve({ sourceTransactionId });
        }
        if (stableSourceKey !== null && identity.stableSourceKey === stableSourceKey) {
          return Promise.resolve({ sourceTransactionId });
        }
      }
      return Promise.resolve(null);
    },

    findFuzzyTransactions: ({ workspaceId, effectiveDate, amountMinor, currencyCode, limit }) => {
      const found: FuzzyTransaction[] = [];
      for (const txn of txnFields.values()) {
        if (
          txn.workspaceId === workspaceId &&
          txn.effectiveDate === effectiveDate &&
          txn.amountMinor === amountMinor &&
          txn.currencyCode === currencyCode
        ) {
          found.push({ transactionId: txn.id, description: txn.description });
          if (found.length >= (limit ?? MATCH_LOOKUP_LIMIT)) {
            break;
          }
        }
      }
      return Promise.resolve(found);
    },

    linkMerged: ({ transactionId, sourceTransactionId }) => {
      const key = `${transactionId}:${sourceTransactionId}`;
      if (merged.has(key)) {
        return Promise.resolve({ created: false });
      }
      merged.add(key);
      const identity = identities.get(sourceTransactionId);
      if (identity) {
        identities.set(sourceTransactionId, { ...identity, canonicalId: transactionId });
      } else {
        identities.set(sourceTransactionId, {
          dataSourceId: "",
          externalId: null,
          stableSourceKey: null,
          canonicalId: transactionId,
        });
      }
      return Promise.resolve({ created: true });
    },

    stageCandidate: (candidate) => {
      for (const existing of candidates.values()) {
        if (
          existing.sourceTransactionId === candidate.sourceTransactionId &&
          existing.candidateTransactionId === candidate.candidateTransactionId
        ) {
          return Promise.resolve({ id: existing.id, created: false });
        }
      }
      const id = nextId("cand");
      const entry: MemoryCandidate = { ...candidate, id };
      candidates.set(id, entry);
      return Promise.resolve({ id, created: true });
    },

    findCandidate: (workspaceId, candidateId) => {
      const candidate = candidates.get(candidateId);
      if (!candidate || candidate.workspaceId !== workspaceId) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        id: candidate.id,
        status: candidate.status,
        importId: candidate.importId,
        dataSourceId: candidate.dataSourceId,
        sourceTransactionId: candidate.sourceTransactionId,
        candidateTransactionId: candidate.candidateTransactionId,
        detail: candidate.detail,
      });
    },

    findCanonicalTransaction: (_workspaceId, transactionId) =>
      Promise.resolve(txnFields.has(transactionId) ? { id: transactionId } : null),

    markCandidate: (workspaceId, candidateId, status) => {
      const candidate = candidates.get(candidateId);
      if (candidate && candidate.workspaceId === workspaceId) {
        candidates.set(candidateId, { ...candidate, status });
      }
      return Promise.resolve();
    },
  };

  // Merged links resolve too (base only knows PRIMARY links).
  const baseFind = base.findTransactionIdBySource.bind(base);
  store.findTransactionIdBySource = async (sourceTransactionId: string) =>
    identities.get(sourceTransactionId)?.canonicalId ?? baseFind(sourceTransactionId);

  return store;
}
