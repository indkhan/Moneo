import { z } from "zod";

export const ATTACHMENT_TYPES = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv", "text/tab-separated-values": "tsv",
} as const;
export type AttachmentType = keyof typeof ATTACHMENT_TYPES;
export const ATTACHMENT_ACCEPT = [...Object.keys(ATTACHMENT_TYPES), ...Object.values(ATTACHMENT_TYPES).map(extension => `.${extension}`)].join(",");
export const ATTACHMENT_HINT = "a photo (JPEG, PNG, WebP), PDF, Word (DOCX), PowerPoint (PPTX), Excel (XLSX) or CSV file";
export const MAX_ATTACHMENTS = 4;
export const ATTACHMENT_ONLY_MESSAGE = "Here is a file I attached.";
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_LABEL = "25 MB";

const extensions = Object.values(ATTACHMENT_TYPES).join("|");
export const attachmentSchema = z.object({
  path: z.string().regex(new RegExp(`^[0-9a-f-]{36}\\/[0-9a-f-]{36}\\.(?:${extensions})$`)),
  name: z.string().trim().min(1).max(200),
  type: z.enum(Object.keys(ATTACHMENT_TYPES) as [AttachmentType, ...AttachmentType[]]),
}).strict();
export type ChatAttachment = z.infer<typeof attachmentSchema>;

export const isImage = (type: AttachmentType) => type.startsWith("image/");
export const attachmentId = (path: string) => path.slice(37, 45);

export const attachmentNote = (attachments: unknown) => {
  const parsed = z.array(attachmentSchema).safeParse(attachments);
  return parsed.success && parsed.data.length ? `\n[Attached earlier: ${parsed.data.map(item => `${item.name} (id ${attachmentId(item.path)})`).join(", ")}]` : "";
};
