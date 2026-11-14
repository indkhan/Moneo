"use client";

import { createContext, isValidElement, useContext, useMemo, useState } from "react";
import Link from "next/link";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import type { Root } from "mdast";
import { ChatChart } from "./chat-chart";
import { IouCard } from "./iou-card";
import { DecisionCard } from "./decision-card";
import { ProposalGroup } from "./proposal-group";
import { CitationChip } from "./citation-chip";
import { CITATION_PATTERN, parseCitation, type Citation } from "@/lib/ai/citations";
import { attachmentId, type ChatAttachment } from "@/lib/ai/chat-attachments";

// Only link known application paths in text nodes, never inside SQL/code blocks.
const appLinks: Plugin<[], Root> = () => tree => {
  function visit(parent: { children?: unknown[] }) {
    if (!parent.children) return;
    parent.children = parent.children.flatMap(child => {
      const node = child as { type: string; value?: string; children?: unknown[] };
      if (["code", "inlineCode", "link", "image"].includes(node.type)) return [node];
      if (node.type !== "text") { visit(node); return [node]; }
      const pattern = /\/money\/transactions\?[\w=&%.-]+/gi;
      const parts: unknown[] = []; let start = 0;
      for (const match of (node.value ?? "").matchAll(pattern)) {
        parts.push({ type: "text", value: node.value!.slice(start, match.index) });
        const label = /[?&]transaction=/.test(match[0]) ? "Open transaction and Undo" : "Open matching transactions";
        parts.push({ type: "link", url: match[0], children: [{ type: "text", value: label }] });
        start = match.index + match[0].length;
      }
      return parts.length ? [...parts, { type: "text", value: node.value!.slice(start) }] : [node];
    });
  }
  visit(tree);
};

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return <div className="ai-code"><div className="ai-code-header"><span>Code · display only</span><button type="button" onClick={async event => {
    const text = event.currentTarget.closest(".ai-code")?.querySelector("pre")?.textContent ?? "";
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); }
  }}>{copied ? "Copied" : "Copy code"}</button></div><pre>{children}</pre></div>;
}

type Cited = { file: ChatAttachment; citation: Citation };
/** The citations of the reply being drawn, which its links point into by index. */
const Citations = createContext<Cited[]>([]);
const CITE_HREF = /^#moneo-cite-(\d+)$/;

/**
 * Citation markers become links to `#moneo-cite-n`, drawn as chips. Only markers naming a file attached in
 * this conversation become chips; any other marker is dropped, and so is one still being written.
 */
export function withCitations(content: string, files: ChatAttachment[], streaming = false) {
  const cited: Cited[] = [];
  const text = (streaming ? content.replace(/\{\{[^}]*\}?$/, "") : content).split(/(```[\s\S]*?(?:```|$))/).map((part, index) => index % 2 ? part
    : part.replace(CITATION_PATTERN, (...match) => {
      const citation = parseCitation(match as unknown as RegExpMatchArray);
      const file = citation && files.findLast(item => attachmentId(item.path) === citation.id);
      if (!citation || !file) return "";
      cited.push({ file, citation });
      return `[source](#moneo-cite-${cited.length - 1})`;
    })).join("");
  return { text, cited };
}

function CitationLink({ href, children }: { href: string; children?: React.ReactNode }) {
  const cited = useContext(Citations)[Number(CITE_HREF.exec(href)?.[1])];
  return cited ? <CitationChip file={cited.file} citation={cited.citation} /> : <span>{children}</span>;
}

// Outside the component: new functions on each render would make React remount everything in a reply,
// so a tapped card would flash "Loading…" and lose its place whenever the page refreshes.
const remarkPlugins = [remarkGfm, appLinks];
const components: Components = {
  // A reply sits inside a page that already has its h1.
  h1: ({ children }) => <h2>{children}</h2>,
  img: () => null,
  pre: ({ children }) => {
    const code = isValidElement<{ className?: string; children?: unknown }>(children) ? children.props : null;
    if (code?.className?.includes("language-moneo-chart") && typeof code.children === "string") return <ChatChart source={code.children} />;
    const proposalId = code?.className?.includes("language-moneo-proposal") && typeof code.children === "string" ? /^[0-9a-f-]{36}$/i.exec(code.children.trim())?.[0] : undefined;
    if (proposalId) return <IouCard id={proposalId} />;
    if (code?.className?.includes("language-moneo-proposals") && typeof code.children === "string") return <ProposalGroup source={code.children} />;
    if (code?.className?.includes("language-moneo-decision") && typeof code.children === "string") return <DecisionCard source={code.children} />;
    return <CodeBlock>{children}</CodeBlock>;
  },
  table: ({ children }) => <div className="ai-table"><table>{children}</table></div>,
  a: ({ href, children }) => {
    if (!href) return <span>{children}</span>;
    if (CITE_HREF.test(href)) return <CitationLink href={href}>{children}</CitationLink>;
    // App paths navigate client-side; anything else opens in a new tab.
    if (href.startsWith("/") && !href.startsWith("//")) return <Link href={href}>{children}</Link>;
    // External links are shown as text only; answers never link off the app.
    return <span>{children}</span>;
  },
};

/** A link the model is still writing would show as raw text and a long URL until its last character arrives. */
const withoutUnfinishedLink = (text: string) => text.replace(/\[[^\]\n]*(\]\([^)\n]*)?$/, "");

/** `files` are the conversation's attachments, which the reply's citation chips may point to. */
export function AiMessage({ content, streaming = false, files = NO_FILES }: { content: string; streaming?: boolean; files?: ChatAttachment[] }) {
  const { text, cited } = useMemo(() => withCitations(content, files, streaming), [content, files, streaming]);
  return <Citations.Provider value={cited}><div className="ai-markdown"><Markdown remarkPlugins={remarkPlugins} skipHtml components={components}>{streaming ? withoutUnfinishedLink(text) : text}</Markdown></div></Citations.Provider>;
}
const NO_FILES: ChatAttachment[] = [];
