"use client";

import { createContext, createElement, Fragment, useContext, useEffect, useState, useTransition, type ComponentProps, type ReactNode } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import type { CardNode } from "@/lib/cards/sandbox";
import type { ParamState } from "@/lib/cards/params";
import type { z } from "zod";
import type { linkTarget } from "@/lib/cards/tree";
import { CARD_HEIGHT, type CardSize } from "@/lib/cards/sizes";
import { CardChart, type CardChartProps } from "./card-chart";

type Live = { params: ParamState[]; setParam: (name: string, value: string) => void; busy: boolean; locale?: string };
const LiveCard = createContext<Live>({ params: [], setParam: () => {}, busy: false });
/** The size Home's grid gives a card; when the user resizes it there, the card fetches its body for the new size. */
export const HomeCardSize = createContext<CardSize | null>(null);

const PAGES: Record<z.infer<typeof linkTarget>["page"], string> = { transactions: "/money/transactions", budgets: "/plan/spending", recurring: "/money/recurring",
  goals: "/plan", accounts: "/money/accounts", wealth: "/money/wealth", plan: "/plan", forecast: "/plan", artifacts: "/ai/artifacts" };
/** Links are built by the app from a typed target; a card never supplies a URL. */
export function linkHref({ page, ...filters }: z.infer<typeof linkTarget>) {
  const query = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return `${PAGES[page]}${page === "transactions" && query.size ? `?${query}` : ""}`;
}

function Money({ minor, currency, signed, compact, className, style }: { minor: string | number; currency: string; signed?: boolean; compact?: boolean; className?: string; style?: React.CSSProperties }) {
  const { locale } = useContext(LiveCard);
  const value = BigInt(minor);
  let text: string;
  try {
    text = compact ? new Intl.NumberFormat(undefined, { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(Number(value) / 10 ** minorDigits(currency))
      : formatMoney(value, currency, locale);
  } catch { text = `${value} ${currency}`; }
  return <span className={`tabular-nums ${className ?? ""}`} style={style}>{signed && value > 0n ? "+" : ""}{text}</span>;
}

function Tabs({ tabs, className, style, scope }: { tabs: { label: string; content: CardNode }[]; className?: string; style?: React.CSSProperties; scope: string }) {
  const [open, setOpen] = useState(0);
  return <div className={className} style={style}>
    <div role="tablist" className="mb-2 inline-flex rounded-lg border border-border p-0.5">{tabs.map((tab, index) => <button key={tab.label} type="button" role="tab" aria-selected={open === index}
      onClick={() => setOpen(index)} className="rounded-md px-2.5 py-1 text-xs text-muted-foreground aria-selected:bg-muted aria-selected:text-foreground">{tab.label}</button>)}</div>
    {/* Every panel is already rendered, so switching is instant. */}
    {tabs.map((tab, index) => <div key={tab.label} role="tabpanel" hidden={open !== index}>{render(tab.content, scope)}</div>)}
  </div>;
}

function Param({ name, variant, className, style }: { name: string; variant?: "pills" | "select"; className?: string; style?: React.CSSProperties }) {
  const { params, setParam, busy } = useContext(LiveCard);
  const param = params.find(item => item.name === name);
  if (!param) return null;
  if (variant === "select" || param.options.length > 5) return <select aria-label={name} value={param.value} disabled={busy} onChange={event => setParam(name, event.target.value)}
    className={`h-7 rounded-lg border border-border bg-card px-2 text-xs ${className ?? ""}`} style={style}>{param.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  return <div className={`inline-flex rounded-lg border border-border p-0.5 ${className ?? ""}`} style={style}>{param.options.map(option => <button key={option.value} type="button" aria-pressed={param.value === option.value}
    disabled={busy} onClick={() => setParam(name, option.value)} className="rounded-md px-2 py-0.5 font-mono text-[11px] text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground">{option.label}</button>)}</div>;
}

/** Turns a checked tree into React elements; Kit names map to the components above. */
function render(node: CardNode, scope: string, key?: number): ReactNode {
  if (typeof node === "string") return node;
  const children = node.children.map((child, index) => render(child, scope, index));
  if (node.type === "#fragment") return <Fragment key={key}>{children}</Fragment>;
  // The tree was checked against each Kit schema before it got here.
  const props = node.props;
  switch (node.type) {
    case "kit:Money": return <Money key={key} {...(props as ComponentProps<typeof Money>)} />;
    case "kit:Chart": return <CardChart key={key} {...(props as CardChartProps)} />;
    case "kit:Tabs": return <Tabs key={key} {...(props as ComponentProps<typeof Tabs>)} scope={scope} />;
    case "kit:Param": return <Param key={key} {...(props as ComponentProps<typeof Param>)} />;
    case "kit:Link": { const { to, ...rest } = node.props as { to: z.infer<typeof linkTarget> }; return <Link key={key} href={linkHref(to)} {...rest} className={`hover:underline ${(rest as { className?: string }).className ?? ""}`}>{children}</Link>; }
    case "kit:Style": return <style key={key}>{(node.props as { css: string }).css}</style>;
    default: return createElement(node.type, { key, ...(node.props as object) }, ...(children.length ? children : []));
  }
}

export type CardViewProps = { cardId: string; title: string; size: CardSize; tree: CardNode | null; error?: string | null; params: ParamState[]; scope: string; version?: number; open?: string; locale?: string };

/**
 * A Home card: the app's own title row, then the card's checked tree in a fixed-height, clipped, isolated box.
 * Nothing in the tree can paint outside the box or cover the rest of Home. Changing a param re-renders it on the server.
 */
export function CardView({ cardId, title, size: renderedSize, tree: initialTree, error: initialError, params: initialParams, scope, version, open, locale }: CardViewProps) {
  const size = useContext(HomeCardSize) ?? renderedSize;
  const [view, setView] = useState({ tree: initialTree, error: initialError ?? null, params: initialParams, size: renderedSize });
  const [busy, start] = useTransition();
  const [seen, setSeen] = useState(initialTree);
  // A server re-render (a new version, another size) replaces what this card showed.
  if (seen !== initialTree) { setSeen(initialTree); setView({ tree: initialTree, error: initialError ?? null, params: initialParams, size: renderedSize }); }
  function load(values: ParamState[]) {
    const query = new URLSearchParams({ size, ...(version ? { v: String(version) } : {}) });
    for (const param of values) query.set(`p.${param.name}`, param.value);
    start(async () => {
      const response = await fetch(`/api/cards/${cardId}?${query}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({ error: "Could not load the card" }));
      setView(current => response.ok ? { tree: body.tree, error: body.error ?? null, params: body.params, size } : { ...current, error: body.error ?? "Could not load the card" });
    });
  }
  const setParam = (name: string, value: string) => load(view.params.map(param => param.name === name ? { ...param, value } : param));
  // Resized on Home: the body was laid out for the old width.
  useEffect(() => { if (size !== view.size) load(view.params); }, [size]); // eslint-disable-line react-hooks/exhaustive-deps
  return <section aria-label={title} className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card" style={{ height: CARD_HEIGHT }}>
    <div className="flex items-baseline justify-between gap-2 px-5 pt-4 pb-2"><h2 className="truncate text-sm font-medium">{title}</h2>{open && <Link href={open} className="shrink-0 text-sm font-medium text-brand hover:underline">Open</Link>}</div>
    <div data-card={scope} className={`relative isolate min-h-0 flex-1 overflow-clip px-5 pb-4 transition-opacity [contain:layout_paint_style] ${busy ? "opacity-60" : ""}`}>
      <LiveCard.Provider value={{ params: view.params, setParam, busy, locale }}>
        {view.tree ? render(view.tree, scope) : null}
      </LiveCard.Provider>
      {view.error && <p role="alert" className="text-sm text-muted-foreground">{view.error}</p>}
    </div>
  </section>;
}
