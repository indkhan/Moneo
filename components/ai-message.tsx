"use client";

import { isValidElement, useState } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import type { Root } from "mdast";
import { ChatChart } from "./chat-chart";

// Only link known application paths in text nodes, never inside SQL/code blocks.
const appLinks: Plugin<[], Root> = () => tree => {
  function visit(parent: { children?: unknown[] }) {
    if (!parent.children) return;
    parent.children = parent.children.flatMap(child => {
      const node = child as { type: string; value?: string; children?: unknown[] };
      if (["code", "inlineCode", "link", "image"].includes(node.type)) return [node];
      if (node.type !== "text") { visit(node); return [node]; }
      const pattern = /\/ai\/library\/[0-9a-f-]{36}|\/money\/transactions\?[\w=&%.-]+/gi;
      const parts: unknown[] = []; let start = 0;
      for (const match of (node.value ?? "").matchAll(pattern)) {
        parts.push({ type: "text", value: node.value!.slice(start, match.index) });
        const label = match[0].startsWith("/ai/") ? "Open saved tool" : /[?&]transaction=/.test(match[0]) ? "Open transaction and Undo" : "Open matching transactions";
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

export function AiMessage({ content }: { content: string }) {
  return <div className="ai-markdown"><Markdown remarkPlugins={[remarkGfm, appLinks]} skipHtml components={{
    img: () => null,
    pre: ({ children }) => {
      const code = isValidElement<{ className?: string; children?: unknown }>(children) ? children.props : null;
      if (code?.className?.includes("language-moneo-chart") && typeof code.children === "string") return <ChatChart source={code.children} />;
      return <CodeBlock>{children}</CodeBlock>;
    },
    table: ({ children }) => <div className="ai-table"><table>{children}</table></div>,
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>;
      const artifact = /^\/ai\/library\/[0-9a-f-]{36}$/.test(href);
      // App paths navigate client-side; anything else opens in a new tab.
      if (href.startsWith("/") && !href.startsWith("//")) return <Link href={href} className={artifact ? "ai-artifact-link" : undefined}>
        {artifact && <span className="ai-artifact-label">Saved tool / open workspace ↗</span>}{children}
      </Link>;
      return <a href={href} {...(/^https?:\/\//i.test(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
    },
  }}>{content}</Markdown></div>;
}
