import { randomUUID } from "node:crypto";
import { recordUsage, type UsageCall, type UsageScope } from "@/lib/ai/usage-ledger";
import { serviceDb } from "@/lib/service-db";

export async function recordVoiceUsage(scope: UsageScope, call: UsageCall): Promise<string | null> {
  let id: string | null = null;
  await recordUsage(scope, call, async row => {
    const rowId = randomUUID();
    const result = await serviceDb().from("ai_usage").insert({ ...row, id: rowId });
    if (!result.error) id = rowId;
    return result;
  });
  return id;
}
