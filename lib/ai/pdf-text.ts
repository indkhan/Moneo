import { extractText } from "unpdf";

/** Text sent to the model per PDF; a long statement is cut here, saying so, rather than flooding the context. */
const MAX_PDF_CHARS = 120_000;

/**
 * A PDF's text layer as plain text, one "Page n" section per page, read on this computer. When there is no
 * text (a scan or photo saved as PDF) the note tells the model to say so and ask for photos instead of guessing.
 */
export async function pdfText(bytes: Uint8Array, name: string): Promise<string> {
  let pages: string[];
  try {
    // pdf.js may take ownership of the buffer, so it gets a copy.
    pages = (await extractText(new Uint8Array(bytes), { mergePages: false })).text;
  } catch {
    return `[Attached PDF "${name}" could not be opened. Tell the user you could not read it and ask them to attach photos of its pages instead.]`;
  }
  const body = pages.map((text, index) => `--- Page ${index + 1} ---\n${text.trim()}`).join("\n\n");
  if (!pages.some(text => text.trim())) return `[Attached PDF "${name}" has no readable text, so it is probably a scan. Tell the user you could not read it and ask them to attach photos of its pages instead.]`;
  const cut = body.length > MAX_PDF_CHARS;
  return `[Attached PDF "${name}", ${pages.length} page${pages.length === 1 ? "" : "s"}, text extracted:]\n${cut ? body.slice(0, MAX_PDF_CHARS) : body}${cut ? "\n[The rest of the PDF was cut because it is long. Tell the user only the first part was read.]" : ""}`;
}
