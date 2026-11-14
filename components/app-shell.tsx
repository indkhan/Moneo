"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, use, useEffect, useState, useSyncExternalStore } from "react";
import {
  ArrowLeftRight, Bell, ChartLine, ChartPie, Coins, CreditCard, LayoutGrid, Layers, ListChecks, Menu, MessageSquare,
  Network, Repeat, Search, SearchCheck, SlidersHorizontal, Sparkles, Tags, Target, TrendingUp, Upload, WandSparkles, type LucideIcon,
} from "lucide-react";
import { AiPanel } from "@/components/ai-panel";
import { ASK_EVENT, type AskSeed } from "@/components/ask-about";
import { CommandPalette, Kbd, Modal, ShortcutHelp, type Command } from "@/components/command-palette";
import { IntentLink } from "@/components/intent-link";
import { cn } from "@/lib/utils";

/** Streamed from the root layout; null when signed out or the lookup failed. */
export type ShellData = { accounts: { id: string; name: string }[]; counts: Partial<Record<string, number>> } | null;

/** `about` says what a page is for where its name alone leaves people guessing. */
type NavItem = { label: string; href: string; icon: LucideIcon; go?: string; about?: string };
/** A rail entry; one with `items` is a section whose pages show as tabs under the header. */
type RailItem = NavItem & { items?: NavItem[] };
const money: RailItem[] = [
  { label: "Overview", href: "/", icon: LayoutGrid, go: "h" },
  { label: "Transactions", href: "/money/transactions", icon: ArrowLeftRight, items: [
    { label: "Ledger", href: "/money/transactions", icon: ArrowLeftRight, go: "t" },
    { label: "Organization", href: "/money/organization", icon: Tags, go: "o" },
    { label: "AI organizer", href: "/money/organize", icon: WandSparkles, about: "What the AI labelled, and what needs you" },
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
];
const ai: RailItem = { label: "AI", href: "/ai", icon: Sparkles, items: [
  { label: "Ask", href: "/ai", icon: MessageSquare, go: "c", about: "Chat about your money" },
  { label: "Agents", href: "/ai/agents", icon: Network, go: "m", about: "Reviews that suggest changes for you to accept" },
  { label: "Artifacts", href: "/ai/artifacts", icon: Layers, about: "Saved reports and tools" },
  { label: "Activity log", href: "/ai/activity", icon: ListChecks, about: "What background work did, and when" },
] };
const rail = [...money, ai];
const noChanges = () => () => {};
const isApple = () => /mac|iphone|ipad/i.test(navigator.userAgent);
const settingsItem: NavItem = { label: "Settings", href: "/settings", icon: SlidersHorizontal, go: "s" };
// The attention view of the activity feed, linked directly: /notifications only redirects there.
const notificationsItem: NavItem = { label: "Needs attention", href: "/ai/activity?filter=attention", icon: Bell, go: "n" };
const allItems: NavItem[] = [...rail.flatMap(item => item.items ?? [item]), settingsItem, notificationsItem];
// Phones: Ask sits in the middle of the tab bar and opens the full-screen chat; everything else is under More.
const askTab: NavItem = { label: "Ask", href: "/ai", icon: Sparkles };
const [homeTab, transactionsTab, planTab] = ["/", "/money/transactions", "/plan"].map(href => rail.find(item => item.href === href)!);
const mobileTabs: NavItem[] = [{ ...homeTab, label: "Home" }, transactionsTab, askTab, planTab];
const menuGroups = [{ label: "Money", items: money.filter(item => !item.items) }, ...rail.filter(item => item.items).map(item => ({ label: item.label, items: item.items! })),
  { label: "Workspace", items: [notificationsItem, settingsItem] }];
const subscribeScroll = (onChange: () => void) => { window.addEventListener("scroll", onChange, { passive: true }); return () => window.removeEventListener("scroll", onChange); };
// The phone header shows the page's own title once its large title has scrolled away, as iOS does; empty before that.
const pastTitle = () => window.scrollY > 48 ? document.querySelector("main h1")?.textContent?.trim() || " " : "";

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
  return <IntentLink href={item.href} aria-current={active ? "page" : undefined}
    className={cn("relative flex w-16 flex-col items-center gap-1.5 rounded-xl py-2.5 text-[11px] transition-colors",
      active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
    <Icon className="size-5" strokeWidth={1.6} aria-hidden="true" />{item.label}
    <Suspense><Count shell={shell} hrefs={hrefs} dot /></Suspense>
  </IntentLink>;
}

function MenuLink({ item, current, shell, onNavigate }: { item: NavItem; current?: NavItem; shell: Promise<ShellData>; onNavigate: () => void }) {
  const Icon = item.icon;
  return <IntentLink href={item.href} onClick={onNavigate} aria-current={current === item ? "page" : undefined}
    className={cn("flex min-h-12 items-center gap-3 px-4 py-2.5 text-[15px] text-foreground active:bg-muted", current === item && "font-medium")}>
    <Icon className={cn("size-5 shrink-0", current === item ? "text-brand" : "text-muted-foreground")} strokeWidth={1.7} aria-hidden="true" /><span className="mr-auto min-w-0"><span className="block truncate">{item.label}</span>{item.about && <span className="block truncate text-xs font-normal text-muted-foreground">{item.about}</span>}</span>
    <Suspense><Count shell={shell} hrefs={[item.href]} /></Suspense>
  </IntentLink>;
}

// Accounts arrive with the streamed shell data; until then the palette lists pages and actions.
function AccountCommands({ shell, base, ...props }: { shell: Promise<ShellData>; base: Command[]; open: boolean; onClose: () => void; onAsk: (question: string) => void; onSearch: (text: string) => void }) {
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
  const apple = useSyncExternalStore(noChanges, isApple, () => false);
  const scrolledTitle = useSyncExternalStore(subscribeScroll, pastTitle, () => "");
  const scrolled = scrolledTitle !== "";

  if (pathname === "/setup") return <>{children}</>;

  const commands: Command[] = [
    { id: "new-chat", label: "New AI chat", group: "Actions", keywords: "ask conversation assistant", run: () => router.push("/ai?conversation=new") },
    { id: "add-transaction", label: "Add a transaction", group: "Actions", keywords: "new expense income manual", run: () => router.push("/money/transactions?add=1#add-transaction") },
    { id: "add-account", label: "Add an account", group: "Actions", keywords: "new bank wallet cash", run: () => router.push("/money/accounts") },
    { id: "set-limit", label: "Set a spending limit", group: "Actions", keywords: "budget plan", run: () => router.push("/plan/spending") },
    { id: "import", label: "Import a statement", group: "Actions", keywords: "upload csv xlsx file", run: () => router.push("/import") },
    { id: "shortcuts", label: "Keyboard shortcuts", group: "Actions", hint: "?", run: () => setHelp(true) },
    ...allItems.map(item => ({ id: item.href, label: item.label, group: "Pages", keywords: [railFor(item)?.label, item.about, item === notificationsItem && "notifications"].filter(Boolean).join(" "),
      hint: item.go && `G ${item.go.toUpperCase()}`, run: () => router.push(item.href) })),
  ];
  const paletteProps = { open: palette, onClose: () => setPalette(false), onAsk: (question: string) => window.dispatchEvent(new CustomEvent<AskSeed>(ASK_EVENT, { detail: { question } })),
    onSearch: (text: string) => router.push(`/money/transactions?q=${encodeURIComponent(text)}`) };

  const artifactEditor = /^\/ai\/artifacts\/[^/]+$/.test(pathname);
  // These pages fill the window and scroll inside their own panes; the page itself stays put.
  const chat = pathname === "/ai";
  const fullHeight = artifactEditor || chat;
  const tabFor = (item: NavItem) => item === askTab ? chat : railFor(item === mobileTabs[0] ? homeTab : item) === section;
  const sectionTabs = !artifactEditor ? section?.items : undefined;
  return <div className={cn("min-h-screen bg-background", fullHeight && "h-dvh overflow-hidden")}>
    <a href="#main-content" className="sr-only z-50 rounded bg-card p-3 text-sm underline focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>
    <nav aria-label="Main" className="fixed inset-y-0 left-0 z-30 hidden w-22 flex-col items-center gap-5 overflow-y-auto border-r border-border bg-sidebar px-3 py-5 lg:flex">
      <Link href="/" aria-label="Moneo home" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-lime font-display text-[22px] font-bold tracking-tighter text-[#0f1011]">m</Link>
      <div className="flex flex-col items-center gap-0.5">
        <p className="eyebrow pb-1 text-[10px]">Money</p>
        {money.map(item => <RailLink key={item.href} item={item} active={section === item} shell={shell} />)}
        <div className="my-2 h-px w-10 bg-border" aria-hidden="true" />
        <RailLink item={ai} active={section === ai} shell={shell} />
        <RailLink item={settingsItem} active={current === settingsItem} shell={shell} />
      </div>
    </nav>
    <div className={cn("min-w-0 lg:pb-0", !chat && "pb-[calc(3.5rem+env(safe-area-inset-bottom))]", "lg:pl-22 lg:transition-[padding] lg:[html[data-ai-panel]_&]:pr-112", fullHeight && "flex h-full flex-col")}>
      {!chat && <header className={cn("sticky top-0 z-20 shrink-0 border-b pt-[env(safe-area-inset-top)] transition-colors lg:hidden", scrolled ? "border-border bg-background/80 backdrop-blur-xl" : "border-transparent bg-background")}>
        <div className="flex h-12 items-center gap-1 pr-2 pl-4">
          <p aria-hidden="true" className={cn("min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight transition-opacity", scrolled ? "opacity-100" : "opacity-0")}>{scrolledTitle.trim() || current?.label}</p>
          <button type="button" onClick={() => setPalette(true)} aria-label="Search or ask Moneo" className="flex size-11 items-center justify-center rounded-full text-foreground active:bg-muted"><Search className="size-[21px]" strokeWidth={1.8} aria-hidden="true" /></button>
          <IntentLink href={notificationsItem.href} aria-label={notificationsItem.label} className="flex size-11 items-center justify-center rounded-full text-foreground active:bg-muted"><Bell className="size-[21px]" strokeWidth={1.8} aria-hidden="true" /></IntentLink>
        </div>
      </header>}
      {sectionTabs && !chat && <nav aria-label={section!.label} className="overflow-x-auto px-4 pt-1 pb-1 lg:hidden">
        <div className="flex w-max gap-0.5 rounded-xl bg-muted p-0.5">
          {sectionTabs.map(item => <IntentLink key={item.href} href={item.href} aria-current={current === item ? "page" : undefined}
            className={cn("flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-[13px] transition-colors", current === item ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground")}>
            {item.label}<Suspense><Count shell={shell} hrefs={[item.href]} /></Suspense>
          </IntentLink>)}
        </div>
      </nav>}
      <header className="hidden shrink-0 border-b border-border bg-background/90 pt-[env(safe-area-inset-top)] backdrop-blur lg:sticky lg:top-0 lg:z-20 lg:block">
        <div className="flex h-19 items-center gap-3 px-4 sm:px-6 lg:px-8">
          <button type="button" onClick={() => setPalette(true)} aria-label="Search or ask Moneo" className="flex h-11 min-w-0 max-w-[620px] flex-1 items-center gap-2.5 rounded-xl border border-input bg-card px-3.5 text-left text-sm text-muted-foreground hover:text-foreground">
            <Search className="size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">Search pages, accounts or ask Moneo…</span>
            <span className="hidden gap-0.5 sm:flex" aria-hidden="true"><Kbd>{apple ? "⌘" : "Ctrl"}</Kbd><Kbd>K</Kbd></span>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <AiPanel />
            <IntentLink href={notificationsItem.href} aria-label={notificationsItem.label} title={notificationsItem.label}
              className="flex size-11 items-center justify-center rounded-xl border border-input hover:bg-muted"><Bell className="size-[18px]" strokeWidth={1.6} aria-hidden="true" /></IntentLink>
          </div>
        </div>
        {sectionTabs && <nav aria-label={section!.label} className="flex gap-1 overflow-x-auto px-4 pb-3 sm:px-6 lg:px-8">
          {sectionTabs.map(item => <IntentLink key={item.href} href={item.href} title={item.about} aria-current={current === item ? "page" : undefined}
            className={cn("flex h-9 shrink-0 items-center gap-2 rounded-[10px] px-3.5 text-[13px]", current === item ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
            {item.label}<Suspense><Count shell={shell} hrefs={[item.href]} /></Suspense>
          </IntentLink>)}
        </nav>}
      </header>
      <div id="main-content" tabIndex={-1} className={fullHeight ? "min-h-0 flex-1 overflow-hidden" : undefined}>{children}</div>
    </div>
    {!chat && <nav aria-label="Main mobile" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-card/85 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur-xl select-none lg:hidden">
      {mobileTabs.map(item => {
        const active = tabFor(item);
        if (item === askTab) return <IntentLink key={item.href} href={item.href} aria-label="Ask Moneo" className="flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-ai">
          <span className="flex size-9 items-center justify-center rounded-full bg-ai text-background shadow-sm"><Sparkles className="size-5" strokeWidth={1.8} aria-hidden="true" /></span>{item.label}
        </IntentLink>;
        return <IntentLink key={item.href} href={item.href} aria-current={active ? "page" : undefined}
          className={cn("flex h-14 flex-col items-center justify-center gap-1 text-[10px] font-medium", active ? "text-brand" : "text-muted-foreground")}>
          <item.icon className="size-6" strokeWidth={active ? 2 : 1.6} aria-hidden="true" />{item.label}
        </IntentLink>;
      })}
      <button type="button" onClick={() => setMenu(true)} aria-haspopup="dialog" className={cn("flex h-14 flex-col items-center justify-center gap-1 text-[10px] font-medium", !mobileTabs.some(tabFor) ? "text-brand" : "text-muted-foreground")}><Menu className="size-6" strokeWidth={1.6} aria-hidden="true" />More</button>
    </nav>}
    <Modal open={menu} onClose={() => setMenu(false)} label="Navigation" className="inset-x-0 bottom-0 top-auto w-full lg:hidden">
      <nav aria-label="All pages" className="max-h-[85dvh] w-full overflow-y-auto rounded-t-[28px] bg-background px-4 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-input" aria-hidden="true" />
        <div className="space-y-5">
          {menuGroups.map(group => <div key={group.label}>
            <p className="eyebrow px-3 pb-1.5">{group.label}</p>
            <div className="divide-y divide-border overflow-hidden rounded-2xl bg-card">
              {group.items.map(child => <MenuLink key={child.href} item={child} current={current} shell={shell} onNavigate={() => setMenu(false)} />)}
            </div>
          </div>)}
        </div>
      </nav>
    </Modal>
    {palette && <Suspense fallback={<CommandPalette commands={commands} {...paletteProps} />}><AccountCommands shell={shell} base={commands} {...paletteProps} /></Suspense>}
    <ShortcutHelp open={help} onClose={() => setHelp(false)} shortcuts={shortcuts} />
  </div>;
}
