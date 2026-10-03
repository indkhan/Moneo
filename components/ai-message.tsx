"use client";

import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import type { Root } from "mdast";

// Only link known application paths in text nodes, never inside SQL/code blocks.
const appLinks: Plugin<[], Root> = () => tree => {
  function visit(parent: { children?: unknown[] }) {
    if (!parent.children) return;
    parent.children = parent.children.flatMap(child => {
      const node = child as { type: string; value?: string; children?: unknown[] };
      if (["code", "inlineCode", "link", "image"].includes(node.type)) return [node];
      if (node.type !== "text") { visit(node); return [node]; }
      const pattern = /\/ai\/library\/[0-9a-f-]{36}|\/money\/transactions\?transaction=[0-9a-f-]{36}/gi;
      const parts: unknown[] = []; let start = 0;
      for (const match of (node.value ?? "").matchAll(pattern)) {
        parts.push({ type: "text", value: node.value!.slice(start, match.index) });
        parts.push({ type: "link", url: match[0], children: [{ type: "text", value: match[0].startsWith("/ai/") ? "Open saved tool" : "Open transaction and Undo" }] });
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

export function AiMessage({ content }: { content: string }) {
  return <div className="ai-markdown"><Markdown remarkPlugins={[remarkGfm, appLinks]} skipHtml components={{
    img: () => null,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    table: ({ children }) => <div className="ai-table"><table>{children}</table></div>,
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>;
      const artifact = /^\/ai\/library\/[0-9a-f-]{36}$/.test(href);
      const external = /^https?:\/\//i.test(href);
      return <a href={href} className={artifact ? "ai-artifact-link" : undefined} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {artifact && <span className="ai-artifact-label">Saved tool / open workspace ↗</span>}{children}
      </a>;
    },
  }}>{content}</Markdown></div>;
}
