import { it } from "vitest";

import { proofPool } from "./db.ts";
import { loadProofEnv } from "./env.ts";
import {
  claimAttempt,
  commitToolEffect,
  persistProviderResponse,
  publishCommittedEffect,
} from "./worker.ts";

it("reaches the requested persisted boundary and waits to be killed", async () => {
  const phase = process.env.E00_KILL_PHASE as
    | "after-claim"
    | "after-provider-response"
    | "after-tool-commit"
    | "after-publish";
  const tenantId = process.env.E00_KILL_TENANT;
  const operationId = process.env.E00_KILL_OPERATION;
  const leaseMs = Number(process.env.E00_KILL_LEASE_MS);
  if (!phase || !tenantId || !operationId || !leaseMs) throw new Error("missing kill-proof input");

  const pool = proofPool(loadProofEnv());
  const claim = await claimAttempt(pool, tenantId, operationId, `kill-proof-${phase}`, leaseMs);
  if (phase !== "after-claim") {
    await persistProviderResponse(pool, tenantId, operationId, claim);
  }
  if (phase === "after-tool-commit" || phase === "after-publish") {
    await commitToolEffect(pool, tenantId, operationId, claim);
  }
  if (phase === "after-publish") {
    await publishCommittedEffect(pool, tenantId, operationId, claim);
  }
  process.stdout.write(`${phase}\n`);
  await new Promise(() => undefined);
}, 60_000);
