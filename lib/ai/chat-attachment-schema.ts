import { z } from "zod";
import { ATTACHMENT_TYPES, attachmentId, type AttachmentType, type ChatAttachment } from "./chat-attachments";

const extensions = Object.values(ATTACHMENT_TYPES).join("|");
export const attachmentSchema = z.object({
  path: z.string().regex(new RegExp(`^[0-9a-f-]{36}\\/[0-9a-f-]{36}\\.(?:${extensions})$`)),
  name: z.string().trim().min(1).max(200),
  type: z.enum(Object.keys(ATTACHMENT_TYPES) as [AttachmentType, ...AttachmentType[]]),
}).strict() satisfies z.ZodType<ChatAttachment>;

export const attachmentNote = (attachments: unknown) => {
  const parsed = z.array(attachmentSchema).safeParse(attachments);
  return parsed.success && parsed.data.length ? `\n[Attached earlier: ${parsed.data.map(item => `${item.name} (id ${attachmentId(item.path)})`).join(", ")}]` : "";
};
