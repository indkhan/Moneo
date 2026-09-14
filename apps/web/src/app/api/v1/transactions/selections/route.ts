import { financeRoute } from "@/lib/finance-api";
import { createFrozenTransactionSelection } from "@moneo/db/transaction-workspace";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { NextResponse } from "next/server";
import { z } from "zod";
import { DomainError, problemResponse } from "@moneo/shared/problem";

const selectionSchema = z
  .object({
    ids: z.array(z.uuid("transaction id must be a UUID")).min(1).max(10_000).optional(),
    filter: z
      .object({
        q: z.string().max(200).optional(),
        accountIds: z.array(z.uuid()).max(100).optional(),
        directions: z
          .array(z.enum(["credit", "debit"]))
          .max(2)
          .optional(),
        dateFrom: z.iso.date().optional(),
        dateTo: z.iso.date().optional(),
        categoryIds: z.array(z.uuid()).max(100).optional(),
        tagNames: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        counterpartyIds: z.array(z.uuid()).max(100).optional(),
        excludedFromAnalytics: z.boolean().optional(),
      })
      .optional(),
  })
  .refine(
    (value) => value.ids !== undefined || value.filter !== undefined,
    "ids or filter is required",
  );

/** Materializes the target before a large mutation; later rows can never join it. */
export async function POST(request: Request) {
  return financeRoute(async (session) => {
    const parsed = selectionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid selection" }, { status: 400 });
    let selection;
    try {
      selection = await withWorkspaceTransaction(session.wid, (tx) =>
        createFrozenTransactionSelection(
          tx,
          session.wid,
          parsed.data.filter ?? {},
          parsed.data.ids,
        ),
      );
    } catch (error) {
      if (error instanceof DomainError) return problemResponse(error);
      throw error;
    }
    return NextResponse.json(
      {
        id: selection.id,
        count: selection.items.length,
        expiresAt: selection.expiresAt.toISOString(),
      },
      { status: 201 },
    );
  });
}
