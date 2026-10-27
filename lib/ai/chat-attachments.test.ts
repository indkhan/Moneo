import { expect, it } from "vitest";
import { attachmentNote, attachmentSchema, sniffType } from "@/lib/ai/chat-attachments";

it("trusts a file's first bytes, not its name", () => {
  expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
  expect(sniffType(new TextEncoder().encode("RIFF....WEBPVP8 "))).toBe("image/webp");
  expect(sniffType(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
  expect(sniffType(new TextEncoder().encode("<svg"))).toBeNull();
});

it("accepts only workspace-folder paths and names earlier files for the model", () => {
  const file = { path: "00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.jpg", name: "receipt.jpg", type: "image/jpeg" };
  expect(attachmentSchema.safeParse(file).success).toBe(true);
  expect(attachmentSchema.safeParse({ ...file, path: "../other/file.jpg" }).success).toBe(false);
  expect(attachmentNote([file])).toBe("\n[Attached earlier: receipt.jpg]");
  expect(attachmentNote([])).toBe("");
});
