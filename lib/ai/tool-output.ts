const INTERNAL_KEYS = new Set(["calculationEvidence", "evidenceReceipts", "workspace_id", "workspaceId"]);
const LIMIT = 2000;

/** The short, user-facing preview of a tool result streamed to the chat; internal fields are left out. */
export function toolOutputPreview(output: unknown): string {
  const shown = JSON.stringify(output, (key, value) => INTERNAL_KEYS.has(key) ? undefined : value, 2) ?? "";
  return shown.length > LIMIT ? `${shown.slice(0, LIMIT)}\n… (truncated)` : shown;
}
