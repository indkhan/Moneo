import JSZip from "jszip";
import type { AttachmentType } from "@/lib/ai/chat-attachments";

// Office files are zip archives; the main part's content type in [Content_Types].xml says which kind.
const OFFICE_PARTS: [string, AttachmentType][] = [
  ["wordprocessingml.document.main+xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["presentationml.presentation.main+xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["spreadsheetml.sheet.main+xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
];

/** Text has no NUL or other control bytes besides tab, line feed, carriage return and form feed. */
function looksLikeText(bytes: Uint8Array) {
  if (!bytes.length) return false;
  for (const byte of bytes.subarray(0, 64 * 1024)) if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) return false;
  return true;
}

/**
 * The file's real type from its bytes, so a renamed file cannot pass as another. Text has no signature, so a
 * CSV or TSV is a file with that extension whose bytes are text.
 */
export async function sniffType(bytes: Uint8Array, name: string): Promise<AttachmentType | null> {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (starts(0x50, 0x4b, 0x03, 0x04)) {
    const types = await JSZip.loadAsync(bytes).then(zip => zip.file("[Content_Types].xml")?.async("string")).catch(() => undefined);
    return OFFICE_PARTS.find(([part]) => types?.includes(part))?.[1] ?? null;
  }
  const extension = /\.(\w+)$/.exec(name)?.[1]?.toLowerCase();
  if ((extension === "csv" || extension === "tsv" || extension === "tab") && looksLikeText(bytes)) return extension === "csv" ? "text/csv" : "text/tab-separated-values";
  return null;
}
