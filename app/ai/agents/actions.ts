"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { decideProposals } from "@/lib/ai/agent-apply";

/** Accept or reject proposals; accepted ones go through the existing audited actions. */
export async function decideAgentProposals(ids: string[], decision: "accept" | "reject") {
  const input = z.object({ ids: z.array(z.uuid()).min(1).max(100), decision: z.enum(["accept", "reject"]) }).parse({ ids, decision });
  const outcomes = await decideProposals(await requireWorkspace(), [...new Set(input.ids)], input.decision);
  revalidatePath("/", "layout");
  return outcomes;
}
