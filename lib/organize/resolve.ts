import { z } from "zod";
import type { Db } from "@/lib/database";

const resolution = z.object({ resolved: z.number(), created: z.number() });
import { loadRawContext } from "@/lib/bank/raw-context";
import { loadOwnAccounts } from "@/lib/finance/own-transfers";
import { identityCandidate } from "./identity";

const PAGE = 500, MAX_ROWS = 10_000;

export async function resolveNewIdentities(db: Db, workspaceId: string) {
  const own = await loadOwnAccounts(db, workspaceId);
  const ownIbans = new Set([...own.tracked.keys(), ...own.untracked.keys()]);
  let after = "00000000-0000-0000-0000-000000000000", resolved = 0, created = 0;
  for (let scanned = 0; scanned < MAX_ROWS; scanned += PAGE) {
    const { data, error } = await db.from("transactions").select("id, description").eq("workspace_id", workspaceId).is("identity_id", null)
      .gt("id", after).order("id").limit(PAGE);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    const raw = await loadRawContext(db, workspaceId, rows.map(row => row.id));
    const items = rows.flatMap(row => {
      const candidate = identityCandidate(row.description, raw.get(row.id), ownIbans);
      return candidate ? [{ transaction_id: row.id, kind: candidate.kind, display_name: candidate.displayName, aliases: candidate.aliases }] : [];
    });
    if (items.length) {
      const result = await db.rpc("resolve_organize_identities", { p_workspace: workspaceId, p_items: items });
      if (result.error) throw new Error(result.error.message);
      const outcome = resolution.parse(result.data);
      resolved += outcome.resolved; created += outcome.created;
    }
    if (rows.length < PAGE) break;
  }
  return { resolved, created };
}
