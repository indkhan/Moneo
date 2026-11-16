import { expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { loadIouProposal } from "./iou-actions";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));

const id = "6f1c1f8e-4c39-4b55-8a3e-0c7a9d1b2c3d";
const secret = "synthetic-payload-secret-4481";

it("loads an IOU card without returning its stored payload", async () => {
  const row = { id, kind: "iou_create", title: "Mohammed owes you", detail: "500 EUR", status: "proposed", result: null, conflict_key: "iou:mohammed",
    payload: { direction: "lent", person: "Mohammed", amountMinor: "50000", currencyCode: "EUR", note: secret }, evidence: { transactions: [] } };
  const query = { select: () => query, eq: () => query, in: () => query, maybeSingle: async () => ({ data: row, error: null }) };
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { from: () => query }, workspace: { id: "w" } } as never);
  const proposal = await loadIouProposal(id);
  expect(proposal).toMatchObject({ id, kind: "iou_create", title: "Mohammed owes you", status: "proposed" });
  expect(proposal).not.toHaveProperty("payload");
  expect(JSON.stringify(proposal)).not.toContain(secret);
});
