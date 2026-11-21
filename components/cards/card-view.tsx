"use client";

import { createContext, createElement, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, useTransition, type ComponentProps, type ReactNode } from "react";
import Link from "next/link";
import { formatCompactMoney, formatMoney } from "@/lib/finance/format";
import type { CardNode } from "@/lib/cards/sandbox";
import type { LocalControl, ParamState } from "@/lib/cards/params";
import type { LocalRun } from "@/lib/cards/local";
import type { z } from "zod";
import type { linkTarget } from "@/lib/cards/tree";
import { CARD_HEIGHT, type CardSize } from "@/lib/cards/sizes";
import { CardChart, type CardChartProps } from "./card-chart";

type Live = { params: ParamState[]; setParam: (name: string, value: string) => void; busy: boolean; locale?: string };
const LiveCard = createContext<Live>({ params: [], setParam: () => {}, busy: false });
export const HomeCardSize = createContext<CardSize | null>(null);

const PAGES: Record<z.infer<typeof linkTarget>["page"], string> = { transactions: "/money/transactions", budgets: "/plan/spending", recurring: "/money/recurring",
  goals: "/plan", accounts: "/money/accounts", wealth: "/money/wealth", plan: "/plan", forecast: "/plan", artifacts: "/ai/artifacts" };
export function linkHref({ page, ...filters }: z.infer<typeof linkTarget>) {
  const query = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return `${PAGES[page]}${page === "transactions" && query.size ? `?${query}` : ""}`;
}

function Money({ minor, currency, signed, compact, className, style }: { minor: string | number; currency: string; signed?: boolean; compact?: boolean; className?: string; style?: React.CSSProperties }) {
  const { locale } = useContext(LiveCard);
  const value = BigInt(minor);
  let text: string;
  try {
    text = compact ? formatCompactMoney(value, currency, locale) : formatMoney(value, currency, locale);
  } catch { text = `${value} ${currency}`; }
  return <span className={`tabular-nums ${className ?? ""}`} style={style}>{signed && value > 0n ? "+" : ""}{text}</span>;
}

function LocalizedChart(props: CardChartProps) {
  const { locale } = useContext(LiveCard);
  return <CardChart {...props} locale={locale} />;
}

type Look = { className?: string; style?: React.CSSProperties };
type Amount = { minor?: string | number; currency?: string; value?: string };

function amountText({ minor, currency, value }: Amount, locale?: string, signed?: boolean) {
  if (minor === undefined || !currency) return value ?? "";
  const amount = BigInt(minor);
  try { return `${signed && amount > 0n ? "+" : ""}${formatMoney(amount, currency, locale)}`; } catch { return `${amount} ${currency}`; }
}
const toneClass = (sign: number) => sign > 0 ? "text-success" : sign < 0 ? "text-danger" : "text-muted-foreground";

function Stat({ label, tone, change, note, className, style, ...amount }: Amount & Look & { label?: string; tone?: "positive" | "negative"; change?: { minor?: string | number; currency?: string; percent?: number }; note?: string }) {
  const { locale } = useContext(LiveCard);
  const figure = amountText(amount, locale);
  const moved = change?.minor !== undefined && change.currency ? amountText({ minor: change.minor, currency: change.currency }, locale, true) : null;
  const percent = change?.percent !== undefined ? `${change.percent > 0 ? "+" : ""}${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(change.percent)}%` : null;
  const sign = change ? Math.sign(change.minor !== undefined ? Number(change.minor) : change.percent ?? 0) : 0;
  return <div className={`@container min-w-0 ${className ?? ""}`} style={style}>
    {label && <p className="eyebrow truncate text-muted-foreground">{label}</p>}
    <p className={`display-figure mt-1 whitespace-nowrap tabular-nums ${tone === "positive" ? "text-success" : tone === "negative" ? "text-danger" : ""}`}
      style={{ fontSize: `min(48px, calc(100cqi / ${Math.max(figure.length, 5) * 0.6}))` }}>{figure}</p>
    {(moved || percent || note) && <p className="mt-1.5 truncate text-xs text-muted-foreground">
      {(moved || percent) && <span className={`font-mono tabular-nums ${toneClass(sign)}`}>{[moved, percent && (moved ? `(${percent})` : percent)].filter(Boolean).join(" ")}</span>}
      {note && <span>{moved || percent ? " · " : ""}{note}</span>}
    </p>}
  </div>;
}

type ListRow = Amount & { label: string; sub?: string; signed?: boolean; share?: number; color?: string };
const ROW_HEIGHT = 32, SUB_ROW_HEIGHT = 42, BAR_HEIGHT = 6, MORE_HEIGHT = 20;

function List({ rows, empty, className, style }: Look & { rows: ListRow[]; empty?: string }) {
  const { locale } = useContext(LiveCard);
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(rows.length);
  const height = (rows.some(row => row.sub) ? SUB_ROW_HEIGHT : ROW_HEIGHT) + (rows.some(row => row.share !== undefined) ? BAR_HEIGHT : 0);
  useLayoutEffect(() => {
    const element = box.current, body = element?.closest<HTMLElement>("[data-card]");
    if (!element || !body) return;
    const measure = () => {
      const bottom = body.getBoundingClientRect().bottom - parseFloat(getComputedStyle(body).paddingBottom);
      const room = bottom - element.getBoundingClientRect().top;
      setFit(rows.length * height <= room ? rows.length : Math.max(1, Math.floor((room - MORE_HEIGHT) / height)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [rows.length, height]);
  if (!rows.length) return <p className={`text-sm text-muted-foreground ${className ?? ""}`} style={style}>{empty ?? "Nothing to show yet."}</p>;
  return <div ref={box} className={`min-w-0 ${className ?? ""}`} style={style}>
    <ul>{rows.slice(0, fit).map((row, index) => <li key={index} className={`flex flex-col justify-center ${row.share === undefined ? "border-b border-border last:border-b-0" : ""}`} style={{ height }}>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          {row.color && <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: row.color }} />}
          <span className="min-w-0"><span className="block truncate text-sm">{row.label}</span>{row.sub && <span className="block truncate text-xs text-muted-foreground">{row.sub}</span>}</span>
        </span>
        <span className={`shrink-0 font-mono text-xs tabular-nums ${row.signed && row.minor !== undefined ? toneClass(Math.sign(Number(row.minor))) : ""}`}>{amountText(row, locale, row.signed)}</span>
      </div>
      {row.share !== undefined && <div aria-hidden="true" className="mt-1 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${row.share * 100}%`, background: row.color ?? "var(--color-brand)" }} /></div>}
    </li>)}</ul>
    {fit < rows.length && <p className="truncate text-xs text-muted-foreground" style={{ height: MORE_HEIGHT, lineHeight: `${MORE_HEIGHT}px` }}>+{rows.length - fit} more</p>}
  </div>;
}

function Progress({ label, current, target, text, color, className, style }: Look & { label?: string; current: number; target: number; text?: string; color?: string }) {
  const share = Math.min(1, Math.max(0, current / target));
  return <div className={`min-w-0 ${className ?? ""}`} style={style}>
    {(label || text) && <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm"><span className="truncate">{label}</span>{text && <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{text}</span>}</div>}
    <div role="progressbar" aria-label={label} aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: color ?? "var(--color-brand)" }} />
    </div>
  </div>;
}

function Columns({ ratio, className, style, children }: Look & { ratio?: number[]; children: ReactNode }) {
  const count = Array.isArray(children) ? children.length : 1;
  return <div className={`grid h-full gap-6 ${className ?? ""}`} style={{ gridTemplateColumns: (ratio ?? Array.from({ length: count }, () => 1)).map(part => `minmax(0, ${part}fr)`).join(" "), ...style }}>{children}</div>;
}

function Tabs({ tabs, className, style, scope }: { tabs: { label: string; content: CardNode }[]; className?: string; style?: React.CSSProperties; scope: string }) {
  const [open, setOpen] = useState(0);
  return <div className={className} style={style}>
    <div role="tablist" className="mb-2 inline-flex rounded-lg border border-border p-0.5">{tabs.map((tab, index) => <button key={tab.label} type="button" role="tab" aria-selected={open === index}
      onClick={() => setOpen(index)} className="rounded-md px-2.5 py-1 text-xs text-muted-foreground aria-selected:bg-muted aria-selected:text-foreground">{tab.label}</button>)}</div>
    {tabs.map((tab, index) => <div key={tab.label} role="tabpanel" hidden={open !== index}>{render(tab.content, scope)}</div>)}
  </div>;
}

function controlValue(control: Extract<LocalControl, { kind: "number" }>, value: number, locale?: string) {
  try {
    if (control.format === "money" && control.currency) return formatMoney(BigInt(Math.round(value)), control.currency, locale);
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value) + (control.format === "percent" ? "%" : "");
  } catch { return String(value); }
}

function LocalParam({ param, control, className, style }: { param: ParamState; control: LocalControl; className?: string; style?: React.CSSProperties }) {
  const { setParam, busy, locale } = useContext(LiveCard);
  if (control.kind === "toggle") {
    const on = param.value === "true";
    return <button type="button" role="switch" aria-checked={on} disabled={busy} onClick={() => setParam(param.name, String(!on))}
      className={`group inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground disabled:opacity-60 ${className ?? ""}`} style={style}>
      <span className="relative h-4 w-7 shrink-0 rounded-full bg-muted ring-1 ring-border transition-colors group-aria-checked:bg-brand group-aria-checked:ring-brand">
        <span className="absolute top-0.5 left-0.5 size-3 rounded-full bg-card shadow-sm transition-transform group-aria-checked:translate-x-3" /></span>
      <span className="truncate">{control.label}</span>
    </button>;
  }
  const value = Number(param.value);
  return <label className={`flex min-w-0 items-center gap-2 text-xs ${className ?? ""}`} style={style}>
    <span className="max-w-[40%] shrink-0 truncate text-muted-foreground">{control.label}</span>
    <input type="range" min={control.min} max={control.max} step={control.step} value={value} disabled={busy} aria-valuetext={controlValue(control, value, locale)}
      onChange={event => setParam(param.name, event.target.value)} className="h-4 min-w-0 flex-1 cursor-pointer accent-brand disabled:opacity-60" />
    <span className="shrink-0 text-right font-mono tabular-nums text-foreground">{controlValue(control, value, locale)}</span>
  </label>;
}

function Param({ name, variant, className, style }: { name: string; variant?: "pills" | "select"; className?: string; style?: React.CSSProperties }) {
  const { params, setParam, busy } = useContext(LiveCard);
  const param = params.find(item => item.name === name);
  if (!param) return null;
  if (param.control) return <LocalParam param={param} control={param.control} className={className} style={style} />;
  if (variant === "select" || param.options.length > 5) return <select aria-label={name} value={param.value} disabled={busy} onChange={event => setParam(name, event.target.value)}
    className={`h-7 rounded-lg border border-border bg-card px-2 text-xs ${className ?? ""}`} style={style}>{param.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  return <div className={`inline-flex rounded-lg border border-border p-0.5 ${className ?? ""}`} style={style}>{param.options.map(option => <button key={option.value} type="button" aria-pressed={param.value === option.value}
    disabled={busy} onClick={() => setParam(name, option.value)} className="rounded-md px-2 py-0.5 font-mono text-[11px] text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground">{option.label}</button>)}</div>;
}

function render(node: CardNode, scope: string, key?: number): ReactNode {
  if (typeof node === "string") return node;
  const children = node.children.map((child, index) => render(child, scope, index));
  if (node.type === "#fragment") return <Fragment key={key}>{children}</Fragment>;
  const props = node.props;
  switch (node.type) {
    case "kit:Money": return <Money key={key} {...(props as ComponentProps<typeof Money>)} />;
    case "kit:Chart": return <LocalizedChart key={key} {...(props as CardChartProps)} />;
    case "kit:Stat": return <Stat key={key} {...(props as ComponentProps<typeof Stat>)} />;
    case "kit:List": return <List key={key} {...(props as ComponentProps<typeof List>)} />;
    case "kit:Progress": return <Progress key={key} {...(props as ComponentProps<typeof Progress>)} />;
    case "kit:Columns": return <Columns key={key} {...(props as Omit<ComponentProps<typeof Columns>, "children">)}>{children}</Columns>;
    case "kit:Tabs": return <Tabs key={key} {...(props as ComponentProps<typeof Tabs>)} scope={scope} />;
    case "kit:Param": return <Param key={key} {...(props as ComponentProps<typeof Param>)} />;
    case "kit:Link": { const { to, ...rest } = node.props as { to: z.infer<typeof linkTarget> }; return <Link key={key} href={linkHref(to)} {...rest} className={`hover:underline ${(rest as { className?: string }).className ?? ""}`}>{children}</Link>; }
    case "kit:Style": return <style key={key}>{(node.props as { css: string }).css}</style>;
    default: return createElement(node.type, { key, ...(node.props as object) }, ...(children.length ? children : []));
  }
}

export type CardViewProps = { cardId: string; title: string; size: CardSize; tree: CardNode | null; error?: string | null; params: ParamState[]; local?: LocalRun | null; scope: string; version?: number; open?: string; locale?: string };

export function CardView({ cardId, title, size: renderedSize, tree: initialTree, error: initialError, params: initialParams, local: initialLocal = null, scope, version, open, locale }: CardViewProps) {
  const size = useContext(HomeCardSize) ?? renderedSize;
  const [view, setView] = useState({ tree: initialTree, error: initialError ?? null, params: initialParams, size: renderedSize, local: initialLocal });
  const [busy, start] = useTransition();
  const [seen, setSeen] = useState(initialTree);
  if (seen !== initialTree) { setSeen(initialTree); setView({ tree: initialTree, error: initialError ?? null, params: initialParams, size: renderedSize, local: initialLocal }); }
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  function load(values: ParamState[]) {
    const ticket = ++request.current;
    const query = new URLSearchParams({ size, ...(version ? { v: String(version) } : {}) });
    for (const param of values) query.set(`p.${param.name}`, param.value);
    start(async () => {
      const response = await fetch(`/api/cards/${cardId}?${query}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({ error: "Could not load the card" }));
      if (ticket !== request.current) return;
      setView(current => response.ok ? { tree: body.tree, error: body.error ?? null, params: body.params, size, local: body.local ?? null } : { ...current, error: body.error ?? "Could not load the card" });
    });
  }
  const next = useRef<{ local: LocalRun; params: ParamState[] } | null>(null);
  const rerunning = useRef(false);
  async function rerun(local: LocalRun, params: ParamState[]) {
    next.current = { local, params };
    if (rerunning.current) return;
    rerunning.current = true;
    const { rerunCard } = await import("@/lib/cards/local");
    const take = () => { const job = next.current; next.current = null; return job; };
    for (let job = take(); job; job = take()) {
      const ticket = request.current;
      const shown = await rerunCard(job.local, job.params, view.size, scope).then(tree => ({ tree, error: null }),
        (cause: unknown) => ({ tree: null, error: `This card could not be shown: ${cause instanceof Error ? cause.message : "unknown error"}` }));
      if (ticket === request.current) setView(current => ({ ...current, ...shown }));
    }
    rerunning.current = false;
  }
  function setParam(name: string, value: string) {
    const params = view.params.map(param => param.name === name ? { ...param, value } : param);
    if (!view.params.find(param => param.name === name)?.control || !view.local) return load(params);
    setView(current => ({ ...current, params }));
    void rerun(view.local, params);
  }
  useEffect(() => { request.current++; if (size !== view.size) load(view.params); }, [size]); // eslint-disable-line react-hooks/exhaustive-deps
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
