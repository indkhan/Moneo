import { listPendingCandidates } from "@moneo/db/import-matching";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { problemResponse } from "@moneo/shared/problem";
import { NextResponse } from "next/server";
import type { MatchCandidate as MatchCandidateDto } from "../generated/client";
import { parseOrProblem } from "./contract";
import { z } from "zod";

/**
 * Issue 4.11 — pending-match review HTTP surface.
 *
 * Lists staged `pending` candidates for one import with both sides'
 * descriptions, so the minimal E4 review UI (and E7's Review inbox on the
 * same rows) can offer link-to-existing / keep-as-distinct. Read-only:
 * decisions go through the audited `matches.resolve` command.
 */

const importIdSchema = z.uuid("import id must be a UUID");

export interface MatchReviewStore {
  list(workspaceId: string, importId: string): Promise<MatchCandidateDto[]>;
}

export function createDrizzleMatchReviewStore(): MatchReviewStore {
  return {
    list: (workspaceId, importId) =>
      withWorkspaceTransaction(workspaceId, (tx) =>
        listPendingCandidates(tx, workspaceId, importId).then((rows) =>
          rows.map((row): MatchCandidateDto => ({
            id: row.id,
            importId: row.importId,
            sourceTransactionId: row.sourceTransactionId,
            candidateTransactionId: row.candidateTransactionId,
            matchRule: row.matchRule as MatchCandidateDto["matchRule"],
            candidateDate: row.candidateDate,
            candidateDescription: row.candidateDescription,
            candidateAmountMinor: row.candidateAmountMinor,
            candidateCurrency: row.candidateCurrency,
            stagedDescription: row.stagedDescription,
            stagedDate: row.stagedDate,
            stagedAmountMinor: row.stagedAmountMinor,
            stagedCurrency: row.stagedCurrency,
            stagedDirection: row.stagedDirection as MatchCandidateDto["stagedDirection"],
            createdAt: row.createdAt.toISOString(),
          })),
        ),
      ),
  };
}

function unauthorized(): Response {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** GET /api/v1/matches/pending?importId= — staged review rows for one import. */
export async function handleListPendingMatches(
  query: string | null,
  ctx: { workspaceId: string | undefined; review: MatchReviewStore },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return unauthorized();
  }
  const params = new URLSearchParams(query ?? "");
  const parsed = parseOrProblem(importIdSchema, params.get("importId"), "/matches/pending");
  if (!parsed.ok) {
    return problemResponse(parsed.error);
  }
  const items = await ctx.review.list(ctx.workspaceId, parsed.data);
  return NextResponse.json({ items });
}
