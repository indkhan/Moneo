export const ATTACHMENT_TYPES = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv", "text/tab-separated-values": "tsv",
} as const;
export type AttachmentType = keyof typeof ATTACHMENT_TYPES;
export type ChatAttachment = { path: string; name: string; type: AttachmentType };
export const ATTACHMENT_ACCEPT = [...Object.keys(ATTACHMENT_TYPES), ...Object.values(ATTACHMENT_TYPES).map(extension => `.${extension}`)].join(",");
export const ATTACHMENT_HINT = "a photo (JPEG, PNG, WebP), PDF, Word (DOCX), PowerPoint (PPTX), Excel (XLSX) or CSV file";
export const MAX_ATTACHMENTS = 4;
export const ATTACHMENT_ONLY_MESSAGE = "Here is a file I attached.";
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_LABEL = "25 MB";

export const isImage = (type: AttachmentType) => type.startsWith("image/");
export const attachmentId = (path: string) => path.slice(37, 45);
