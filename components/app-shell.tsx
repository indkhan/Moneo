"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, use, useEffect, useState } from "react";
import {
  ArrowLeftRight, Bell, ChartLine, ChartPie, Coins, CreditCard, LayoutGrid, Layers, ListChecks, Menu, MessageSquare,
  Network, Repeat, Search, SearchCheck, SlidersHorizontal, Tags, Target, TrendingUp, Upload, type LucideIcon,
} from "lucide-react";
import { AiPanel } from "@/components/ai-panel";
import { ASK_EVENT, type AskSeed } from "@/components/ask-about";
import { CommandPalette, Modal, ShortcutHelp, type Command } from "@/components/command-palette";
import { cn } from "@/lib/utils";

/** Streamed from the root layout; null when signed out or the lookup failed. */
export type ShellData = { accounts: { id: string; name: string }[]; counts: Partial<Record<string, number>> } | null;

type NavItem = { label: string; href: string; icon: LucideIcon; go?: string };
/** A rail entry; one with `items` is a section whose pages show as tabs under the header. */
type RailItem = NavItem & { items?: NavItem[] };
const rail: RailItem[] = [
  { label: "Overview", href: "/", icon: LayoutGrid, go: "h" },
  { label: "Activity", href: "/money/transactions", icon: ArrowLeftRight, items: [
    { label: "Transactions", href: "/money/transactions", icon: ArrowLeftRight, go: "t" },
    { label: "Organization", href: "/money/organization", icon: Tags, go: "o" },
    { label: "Investigations", href: "/money/investigations", icon: SearchCheck },
    { label: "Import", href: "/import", icon: Upload, go: "i" },
  ] },
  { label: "Accounts", href: "/money/accounts", icon: CreditCard, go: "a" },
  { label: "Recurring", href: "/money/recurring", icon: Repeat, go: "r" },
  { label: "Plan", href: "/plan", icon: Target, items: [
    { label: "Forecast", href: "/plan", icon: ChartLine, go: "p" },
    { label: "Spending", href: "/plan/spending", icon: ChartPie },
    { label: "Currency", href: "/plan/currency", icon: Coins },
  ] },
  { label: "Wealth", href: "/money/wealth", icon: TrendingUp, go: "w" },
  { label: "Ask", href: "/ai", icon: MessageSquare, go: "c" },
  { label: "Agents", href: "/ai/agents", icon: Network, items: [
    { label: "Agent team", href: "/ai/agents", icon: Network, go: "m" },
    { label: "Activity log", href: "/ai/activity", icon: ListChecks },
  ] },
  { label: "Artifacts", href: "/ai/artifacts", icon: Layers },
];
const settingsItem: NavItem = { label: "Settings", href: "/settings", icon: SlidersHorizontal, go: "s" };
const notificationsItem: NavItem = { label: "Notifications", href: "/notifications", icon: Bell, go: "n" };
const allItems: NavItem[] = [...rail.flatMap(item => item.items ?? [item]), settingsItem, notificationsItem];
const mobileTabs = ["/", "/money/transactions", "/plan", "/ai"].map(href => rail.find(item => item.href === href)!);

/** The nav item whose href is the longest prefix of the path ("/" only matches itself). */
export function activeItem(pathname: string) {
  return allItems.filter(item => pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
const railFor = (item?: NavItem) => item && rail.find(entry => entry === item || entry.items?.includes(item));

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || !!target.closest("dialog[open]"));

const shortcuts = [
  { keys: ["Ctrl/⌘", "K"], label: "Open command palette" },
  { keys: ["?"], label: "Show keyboard shortcuts" },
  ...allItems.filter(item => item.go).map(item => ({ keys: ["G", item.go!.toUpperCase()], label: `Go to ${item.label}` })),
];

function Count({ shell, hrefs, dot }: { shell: Promise<ShellData>; hrefs: string[]; dot?: boolean }) {
  const counts = use(shell)?.counts;
  const count = hrefs.reduce((sum, href) => sum + (counts?.[href] ?? 0), 0);
  if (!count) return null;
  if (dot) return <span className="absolute right-3 top-2 size-2 rounded-full bg-ai"><span className="sr-only">, {count} pending</span></span>;
  return <span className="rounded-full font-mono text-[11px] tabular-nums text-ai">
    <span aria-hidden="true">{count > 99 ? "99+" : count}</span><span className="sr-only">, {count} pending</span>
  </span>;
}

function RailLink({ item, active, shell }: { item: RailItem | NavItem; active: boolean; shell: Promise<ShellData> }) {
  const Icon = item.icon;
  const hrefs = "items" in item && item.items ? item.items.map(child => child.href) : [item.href];
  return <Link href={item.href} aria-current={active ? "page" : undefined}
    className={cn("relative flex w-16 flex-col items-center gap-1.5 rounded-xl py-2.5 text-[11px] transition-colors",
      active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
    <Icon className="size-5" strokeWidth={1.6} aria-hidden="true" />{item.label}
    <Suspense><Count shell={shell} hrefs={hrefs} dot /></Suspense>
  </Link>;
}

function MenuLink({ item, current, shell, onNavigate }: { item: NavItem; current?: NavItem; shell: Promise<ShellData>; onNavigate: () => void }) {
  const Icon = item.icon;
  return <Link href={item.href} onClick={onNavigate} aria-current={current === item ? "page" : undefined}
    className={cn("flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm", current === item ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted")}>
    <Icon className="size-4 shrink-0" aria-hidden="true" /><span className="mr-auto truncate">{item.label}</span>
    <Suspense><Count shell={shell} hrefs={[item.href]} /></Suspense>
  </Link>;
}

// Accounts arrive with the streamed shell data; until then the palette lists pages and actions.
function AccountCommands({ shell, base, ...props }: { shell: Promise<ShellData>; base: Command[]; open: boolean; onClose: () => void; onAsk: (question: string) => void }) {
  const router = useRouter();
  const accounts: Command[] = (use(shell)?.accounts ?? []).map(account => ({ id: `account:${account.id}`, label: account.name, group: "Accounts", keywords: "account transactions",
    run: () => router.push(`/money/transactions?account=${encodeURIComponent(account.id)}`) }));
  return <CommandPalette commands={[...base, ...accounts]} {...props} />;
}

export function AppShell({ children, shell }: { children: React.ReactNode; shell: Promise<ShellData> }) {
  const pathname = usePathname();
  const router = useRouter();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [menu, setMenu] = useState(false);
  const current = activeItem(pathname);
  const section = railFor(current);

  useEffect(() => {
    let pendingG = 0;
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette(open => !open); return; }
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return;
      if (event.key === "?") { setHelp(true); return; }
      const key = event.key.toLowerCase();
      if (Date.now() - pendingG < 1000) {
        pendingG = 0;
        const item = allItems.find(item => item.go === key);
        if (item) { event.preventDefault(); router.push(item.href); }
      } else if (key === "g") pendingG = Date.now();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  if (pathname === "/login" || pathname === "/privacy" || pathname === "/terms" || pathname.startsWith("/privacy/") || pathname.startsWith("/terms/")) return <>{children}</>;

  const commands: Command[] = [
    { id: "new-chat", label: "New AI chat", group: "Actions", keywords: "ask conversation assistant", run: () => router.push("/ai?conversation=new") },
    { id: "import", label: "Import a statement", group: "Actions", keywords: "upload csv xlsx file", run: () => router.push("/import") },
    { id: "shortcuts", label: "Keyboard shortcuts", group: "Actions", hint: "?", run: () => setHelp(true) },
    ...allItems.map(item => ({ id: item.href, label: item.label, group: "Pages", keywords: railFor(item)?.label,
      hint: item.go && `G ${item.go.toUpperCase()}`, run: () => router.push(item.href) })),
  ];
  const paletteProps = { open: palette, onClose: () => setPalette(false), onAsk: (question: string) => window.dispatchEvent(new CustomEvent<AskSeed>(ASK_EVENT, { detail: { question } })) };

  return <div className="min-h-screen bg-background">
    <a href="#main-content" className="sr-only z-50 rounded bg-card p-3 text-sm underline focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>
    <nav aria-label="Main" className="fixed inset-y-0 left-0 z-30 hidden w-22 flex-col items-center gap-5 overflow-y-auto border-r border-border bg-sidebar px-3 py-5 lg:flex">
      <Link href="/" aria-label="Moneo home" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-lime font-display text-[22px] font-bold tracking-tighter text-[#0f1011]">m</Link>
      <div className="flex flex-col items-center gap-0.5">
        {rail.map(item => <RailLink key={item.href} item={item} active={section === item} shell={shell} />)}
        <RailLink item={settingsItem} active={current === settingsItem} shell={shell} />
      </div>
    </nav>
    <div className="min-w-0 pb-16 lg:pb-0 lg:pl-22 lg:transition-[padding] lg:[html[data-ai-panel]_&]:pr-112">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="flex h-19 items-center gap-3 px-4 sm:px-6 lg:px-8">
          <AiPanel onPalette={() => setPalette(true)} />
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => setPalette(true)} aria-label="Open command palette" className="flex size-10 items-center justify-center rounded-xl border border-input text-muted-foreground hover:text-foreground lg:hidden"><Search className="size-[18px]" aria-hidden="true" /></button>
            <Link href={notificationsItem.href} aria-label="Notifications" aria-current={current === notificationsItem ? "page" : undefined}
              className={cn("flex size-10 items-center justify-center rounded-xl border border-input hover:bg-muted", current === notificationsItem && "bg-muted")}><Bell className="size-[18px]" strokeWidth={1.6} aria-hidden="true" /></Link>
            <Link href={settingsItem.href} aria-label="Settings" className="flex size-10 items-center justify-center rounded-full bg-input text-muted-foreground hover:text-foreground lg:hidden"><SlidersHorizontal className="size-[18px]" aria-hidden="true" /></Link>
          </div>
        </div>
        {section?.items && <nav aria-label={section.label} className="flex gap-1 overflow-x-auto px-4 pb-3 sm:px-6 lg:px-8">
          {section.items.map(item => <Link key={item.href} href={item.href} aria-current={current === item ? "page" : undefined}
            className={cn("flex h-9 shrink-0 items-center gap-2 rounded-[10px] px-3.5 text-[13px]", current === item ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
            {item.label}<Suspense><Count shell={shell} hrefs={[item.href]} /></Suspense>
          </Link>)}
        </nav>}
      </header>
      <div id="main-content" tabIndex={-1}>{children}</div>
    </div>
    <nav aria-label="Main mobile" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      {mobileTabs.map(item => <Link key={item.href} href={item.href} aria-current={section === item ? "page" : undefined}
        className={cn("flex flex-col items-center gap-0.5 py-2 text-[11px]", section === item ? "font-medium text-foreground" : "text-muted-foreground")}>
        <item.icon className={cn("size-5", section === item && "text-brand")} strokeWidth={1.6} aria-hidden="true" />{item.label}
      </Link>)}
      <button type="button" onClick={() => setMenu(true)} aria-haspopup="dialog" className="flex flex-col items-center gap-0.5 py-2 text-[11px] text-muted-foreground"><Menu className="size-5" aria-hidden="true" />More</button>
    </nav>
    <Modal open={menu} onClose={() => setMenu(false)} label="Navigation" className="inset-x-0 bottom-0 top-auto w-full lg:hidden">
      <nav aria-label="All pages" className="max-h-[80vh] w-full space-y-4 overflow-y-auto rounded-t-2xl border-t border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {rail.map(item => <div key={item.href} className="space-y-0.5">
          {item.items && <p className="eyebrow px-3 pb-1">{item.label}</p>}
          {(item.items ?? [item]).map(child => <MenuLink key={child.href} item={child} current={current} shell={shell} onNavigate={() => setMenu(false)} />)}
        </div>)}
        <div className="border-t border-border pt-3">{[notificationsItem, settingsItem].map(item => <MenuLink key={item.href} item={item} current={current} shell={shell} onNavigate={() => setMenu(false)} />)}</div>
      </nav>
    </Modal>
    {palette && <Suspense fallback={<CommandPalette commands={commands} {...paletteProps} />}><AccountCommands shell={shell} base={commands} {...paletteProps} /></Suspense>}
    <ShortcutHelp open={help} onClose={() => setHelp(false)} shortcuts={shortcuts} />
  </div>;
}
