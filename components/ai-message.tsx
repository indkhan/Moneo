"use client";

import { isValidElement, useState } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import type { Root } from "mdast";
import { ChatChart } from "./chat-chart";
import { IouCard } from "./iou-card";
import { DecisionCard } from "./decision-card";
import { ProposalGroup } from "./proposal-group";
import { AnswerChart, ChartBoundary, parseChartOption } from "./chart";

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

export function AiMessage({ content }: { content: string }) {
  return <div className="ai-markdown"><Markdown remarkPlugins={[remarkGfm, appLinks]} skipHtml components={{
    img: () => null,
    pre: ({ children }) => {
      const code = isValidElement<{ className?: string; children?: unknown }>(children) ? children.props : null;
      if (code?.className?.includes("language-moneo-chart") && typeof code.children === "string") return <ChatChart source={code.children} />;
      const proposalId = code?.className?.includes("language-moneo-proposal") && typeof code.children === "string" ? /^[0-9a-f-]{36}$/i.exec(code.children.trim())?.[0] : undefined;
      if (proposalId) return <IouCard id={proposalId} />;
      if (code?.className?.includes("language-moneo-proposals") && typeof code.children === "string") return <ProposalGroup source={code.children} />;
      if (code?.className?.includes("language-moneo-decision") && typeof code.children === "string") return <DecisionCard source={code.children} />;
      // A chart that fails to parse or render stays visible as its source code.
      const chart = /\blanguage-chart\b/.test(code?.className ?? "") && typeof code?.children === "string" ? parseChartOption(code.children) : null;
      if (chart) return <ChartBoundary fallback={<CodeBlock>{children}</CodeBlock>}><AnswerChart option={chart} /></ChartBoundary>;
      return <CodeBlock>{children}</CodeBlock>;
    },
    table: ({ children }) => <div className="ai-table"><table>{children}</table></div>,
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>;
      // App paths navigate client-side; anything else opens in a new tab.
      if (href.startsWith("/") && !href.startsWith("//")) return <Link href={href}>{children}</Link>;
      // External links are shown as text only; answers never link off the app.
      return <span>{children}</span>;
    },
  }}>{content}</Markdown></div>;
}
