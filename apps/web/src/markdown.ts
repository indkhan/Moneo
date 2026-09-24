// E04-S04 sanitized markdown subset: only a whitelisted set of inline
// formatting and block elements; no remote resources, no scripts, no
// navigation, no HTML passthrough. The host renders trusted components;
// model output never produces raw HTML.

import { escapeHtml } from "./ui/shell.ts";

const INLINE_CODE = /`([^`\n]+)`/g;
const BOLD = /\*\*([^\*\n]+)\*\*/g;
const ITALIC = /\*([^\*\n]+)\*/g;
const STRIKETHROUGH = /~~([^~\n]+)~~/g;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const IMAGE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const HEADER = /^(#{1,3})\s+(.+)$/gm;
const BLOCKQUOTE = /^>\s+(.+)$/gm;
const UNORDERED = /^[-*]\s+(.+)$/gm;
const ORDERED = /^\d+\.\s+(.+)$/gm;
const CODE_BLOCK = /```([\s\S]*?)```/g;
const HR = /^---$/gm;
const NEWLINE = /\r?\n/;

type SanitizedLink = { text: string; href: string; safe: boolean };

/** Validate that a URL is a safe https link (no javascript:, data:, etc.). */
function safeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Escape, then selectively restore whitelisted inline markdown. */
function inlineMarkdown(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(CODE_BLOCK, (_, code) => `<pre><code>${escapeHtml(code.trim())}</code></pre>`);
  out = out.replace(INLINE_CODE, (_, code) => `<code>${escapeHtml(code)}</code>`);
  out = out.replace(BOLD, (_, txt) => `<strong>${escapeHtml(txt)}</strong>`);
  out = out.replace(ITALIC, (_, txt) => `<em>${escapeHtml(txt)}</em>`);
  out = out.replace(STRIKETHROUGH, (_, txt) => `<del>${escapeHtml(txt)}</del>`);
  out = out.replace(LINK, (_, label, url) => {
    const safe = safeUrl(url);
    return safe ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(label)}</a>` : escapeHtml(label);
  });
  out = out.replace(IMAGE, (_, alt, url) => {
    // Images are never loaded remotely; render as safe alt-text link.
    const safe = safeUrl(url);
    const label = alt.trim() ? alt : "image";
    return safe ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank" class="md-image-link">🖼 ${escapeHtml(label)}</a>` : escapeHtml(alt);
  });
  return out;
}

/** Convert block-level markdown to sanitized HTML. */
export function renderMarkdown(markdown: string): string {
  if (!markdown.trim()) return "";
  let out = markdown;

  // Protect code blocks from line-based transforms
  const codeBlocks: string[] = [];
  out = out.replace(CODE_BLOCK, (_, code) => {
    codeBlocks.push(code.trim());
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  out = out.replace(HEADER, (_, hashes, txt) => `<h${hashes.length}>${inlineMarkdown(txt)}</h${hashes.length}>`);
  out = out.replace(BLOCKQUOTE, (_, txt) => `<blockquote>${inlineMarkdown(txt)}</blockquote>`);
  out = out.replace(HR, () => "<hr>");
  out = out.replace(UNORDERED, (_, txt) => `<li>${inlineMarkdown(txt)}</li>`);
  out = out.replace(ORDERED, (_, txt) => `<li>${inlineMarkdown(txt)}</li>`);

  // Wrap consecutive <li> in <ul>/<ol>
  out = out.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
    const isOrdered = /^\d+\./.test(match.trim().split("\n")[0]);
    return (isOrdered ? "<ol>" : "<ul>") + match + (isOrdered ? "</ol>" : "</ul>");
  });

  // Restore code blocks
  out = out.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => `<pre><code>${escapeHtml(codeBlocks[Number(idx)])}</code></pre>`);

  // Paragraphs: split by blank lines, wrap non-block lines in <p>
  const lines = out.split(NEWLINE);
  const result: string[] = [];
  let inPara = false;
  for (const line of lines) {
    if (line.trim() === "") {
      if (inPara) {
        result.push("</p>");
        inPara = false;
      }
      result.push("");
    } else if (/^<(h[1-3]|ul|ol|li|blockquote|pre|hr)/.test(line.trim())) {
      if (inPara) {
        result.push("</p>");
        inPara = false;
      }
      result.push(line);
    } else {
      if (!inPara) {
        result.push("<p>");
        inPara = true;
      }
      result.push(inlineMarkdown(line));
    }
  }
  if (inPara) result.push("</p>");

  return result.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Extract plain text from markdown for preview/tooltip (no HTML). */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(CODE_BLOCK, (_, code) => code.trim())
    .replace(INLINE_CODE, (_, code) => code)
    .replace(BOLD, (_, txt) => txt)
    .replace(ITALIC, (_, txt) => txt)
    .replace(STRIKETHROUGH, (_, txt) => txt)
    .replace(LINK, (_, label) => label)
    .replace(IMAGE, (_, alt) => alt)
    .replace(HEADER, (_, __, txt) => txt)
    .replace(BLOCKQUOTE, (_, txt) => txt)
    .replace(UNORDERED, (_, txt) => txt)
    .replace(ORDERED, (_, txt) => txt)
    .replace(HR, "");
}

export function truncateMarkdown(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown;
  const truncated = markdown.slice(0, maxChars);
  // Try to end at a sentence boundary
  const lastPeriod = truncated.lastIndexOf(".");
  return lastPeriod > maxChars * 0.5 ? truncated.slice(0, lastPeriod + 1) : truncated + "…";
}