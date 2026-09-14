import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { isWorkspaceOwner } from "@moneo/db/workspaces";

export class AiOwnerRequiredError extends Error {
  constructor() {
    super("Only a workspace owner can manage AI settings and credentials.");
    this.name = "AiOwnerRequiredError";
  }
}

export async function isAiOwner(workspaceId: string, userId: string): Promise<boolean> {
  return withWorkspaceTransaction(workspaceId, (tx) => isWorkspaceOwner(tx, workspaceId, userId));
}

export async function requireAiOwner(workspaceId: string, userId: string): Promise<void> {
  if (!(await isAiOwner(workspaceId, userId))) throw new AiOwnerRequiredError();
}
