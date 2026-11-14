import type { SupabaseClient } from "@supabase/supabase-js";
import { attachmentId, isImage, type ChatAttachment } from "@/lib/ai/chat-attachments";
import { renderPdfPages } from "./extract";
import { documentForModel } from "./read";
import { documentText, downloadAttachment } from "./store";

/** Text sent for all of a message's documents together; each gets an equal share, and document_read reads the rest. */
const TEXT_BUDGET = 150_000;
const MIN_DOCUMENT_BUDGET = 20_000;
/** Scanned PDF pages drawn as images per message. */
export const MAX_PAGE_IMAGES = 10;

type Part = { type: "text"; text: string } | { type: "file"; data: Uint8Array; mediaType: string; filename?: string };

const ranges = (pages: number[]) => pages.reduce<[number, number][]>((list, page) => {
  const last = list.at(-1);
  if (last && last[1] === page - 1) last[1] = page; else list.push([page, page]);
  return list;
}, []).map(([from, to]) => from === to ? `${from}` : `${from}-${to}`).join(", ");

/**
 * A message's files as model input, the same for every AI source: photos stay images; documents become text
 * read on this computer, with scanned PDF pages drawn as images.
 */
export async function attachmentParts(supabase: SupabaseClient, files: ChatAttachment[], render = renderPdfPages): Promise<Part[]> {
  const documents = files.filter(file => !isImage(file.type)).length;
  const budget = Math.max(MIN_DOCUMENT_BUDGET, Math.floor(TEXT_BUDGET / Math.max(1, documents)));
  let images = MAX_PAGE_IMAGES;
  const parts: Part[] = [];
  for (const file of files) {
    const id = attachmentId(file.path);
    const bytes = await downloadAttachment(supabase, file);
    if (isImage(file.type)) {
      parts.push({ type: "text", text: `[Photo "${file.name}" (id ${id}). Cite it as {{cite ${id}}}.]` }, { type: "file", data: bytes, mediaType: file.type, filename: file.name });
      continue;
    }
    let document;
    try { document = await documentText(supabase, file, bytes); }
    catch {
      parts.push({ type: "text", text: `[Attached file "${file.name}" (id ${id}) could not be opened; it may be damaged or password-protected. Tell the owner you could not read it.]` });
      continue;
    }
    const scanned = document.scannedPages ?? [];
    const drawn = scanned.slice(0, images);
    images -= drawn.length;
    const pageImages = drawn.length ? await render(bytes, drawn).catch(error => { console.error("rendering PDF pages failed", error); return []; }) : [];
    const sent = new Set(pageImages.map(item => item.page));
    const skipped = scanned.filter(page => !sent.has(page));
    parts.push({ type: "text", text: documentForModel(document, file.name, id, budget, sent)
      + (skipped.length ? `\n[Pages ${ranges(skipped)} have no text layer and were not sent as images (at most ${MAX_PAGE_IMAGES} page images per message). Tell the owner those pages were not read.]` : "") });
    for (const { page, image } of pageImages)
      parts.push({ type: "text", text: `[Page ${page} of "${file.name}" (id ${id}), a scan:]` }, { type: "file", data: image, mediaType: "image/jpeg", filename: `${file.name} page ${page}.jpg` });
  }
  return parts;
}
