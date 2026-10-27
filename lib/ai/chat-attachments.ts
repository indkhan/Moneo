import { z } from "zod";

// Photos and PDFs a person attaches to a chat message. Files live in the private "chat" bucket under the workspace id.
export const ATTACHMENT_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" } as const;
export type AttachmentType = keyof typeof ATTACHMENT_TYPES;
export const MAX_ATTACHMENTS = 4;
/** Sent when someone attaches files without typing anything. */
export const ATTACHMENT_ONLY_MESSAGE = "Here is a file I attached.";
/** Under the 4.5 MB serverless request limit; photos are downscaled before upload. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export const attachmentSchema = z.object({
  path: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:jpg|png|webp|pdf)$/),
  name: z.string().trim().min(1).max(200),
  type: z.enum(Object.keys(ATTACHMENT_TYPES) as [AttachmentType, ...AttachmentType[]]),
}).strict();
export type ChatAttachment = z.infer<typeof attachmentSchema>;

/** The file's real type from its first bytes, so a renamed file cannot pass as another. */
export function sniffType(bytes: Uint8Array): AttachmentType | null {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  return null;
}

/** How an earlier message's files appear to the model; only the current message sends file contents. */
export const attachmentNote = (attachments: unknown) => {
  const parsed = z.array(attachmentSchema).safeParse(attachments);
  return parsed.success && parsed.data.length ? `\n[Attached earlier: ${parsed.data.map(item => item.name).join(", ")}]` : "";
};
