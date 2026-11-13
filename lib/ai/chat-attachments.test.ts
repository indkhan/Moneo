import { expect, it } from "vitest";
import { attachmentNote, attachmentSchema } from "@/lib/ai/chat-attachments";

it("accepts only workspace-folder paths and lists earlier files for the model with their ids", () => {
  const file = { path: "00000000-0000-4000-8000-000000000001/a1b2c3d4-0000-4000-8000-000000000002.xlsx", name: "budget.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  expect(attachmentSchema.safeParse(file).success).toBe(true);
  expect(attachmentSchema.safeParse({ ...file, path: "../other/file.xlsx" }).success).toBe(false);
  expect(attachmentSchema.safeParse({ ...file, path: file.path.replace(".xlsx", ".exe") }).success).toBe(false);
  expect(attachmentNote([file])).toBe("\n[Attached earlier: budget.xlsx (id a1b2c3d4)]");
  expect(attachmentNote([])).toBe("");
});
