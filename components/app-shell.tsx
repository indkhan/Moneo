"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, use, useEffect, useState, useSyncExternalStore } from "react";
import {
  ArrowLeftRight, Bell, ChartLine, ChartPie, Coins, House, Landmark, Library, ListChecks, Menu, MessageSquare,
  PanelLeftClose, PanelLeftOpen, Repeat, Search, SearchCheck, Settings, Tags, TrendingUp, Upload, type LucideIcon,
} from "lucide-react";
import { AiPanel } from "@/components/ai-panel";
import { CommandPalette, Kbd, Modal, ShortcutHelp, type Command } from "@/components/ui/command-palette";
import { cn } from "@/lib/utils";

/** Streamed from the root layout; null when signed out or the lookup failed. */
export type ShellData = { accounts: { id: string; name: string }[]; counts: Partial<Record<string, number>> } | null;

type NavItem = { label: string; href: string; icon: LucideIcon; go?: string };
const sections: { title: string; items: NavItem[] }[] = [
  { title: "Overview", items: [
    { label: "Home", href: "/", icon: House, go: "h" },
    { label: "Notifications", href: "/notifications", icon: Bell, go: "n" },
  ] },
  { title: "Money", items: [
    { label: "Transactions", href: "/money/transactions", icon: ArrowLeftRight, go: "t" },
    { label: "Accounts", href: "/money/accounts", icon: Landmark, go: "a" },
    { label: "Recurring", href: "/money/recurring", icon: Repeat, go: "r" },
    { label: "Organization", href: "/money/organization", icon: Tags, go: "o" },
    { label: "Wealth", href: "/money/wealth", icon: TrendingUp, go: "w" },
    { label: "Investigations", href: "/money/investigations", icon: SearchCheck },
  ] },
  { title: "Plan", items: [
    { label: "Forecast", href: "/plan", icon: ChartLine, go: "p" },
    { label: "Spending", href: "/plan/spending", icon: ChartPie },
    { label: "Currency", href: "/plan/currency", icon: Coins },
  ] },
  { title: "AI", items: [
    { label: "Chat", href: "/ai", icon: MessageSquare, go: "c" },
    { label: "Library", href: "/ai/library", icon: Library, go: "l" },
    { label: "Activity", href: "/ai/activity", icon: ListChecks },
  ] },
  { title: "Data", items: [{ label: "Import", href: "/import", icon: Upload, go: "i" }] },
];
const settingsItem: NavItem = { label: "Settings", href: "/settings", icon: Settings, go: "s" };
const allItems = [...sections.flatMap(section => section.items), settingsItem];
const mobileTabs = ["/", "/money/transactions", "/plan", "/ai"].map(href => allItems.find(item => item.href === href)!);

/** The nav item whose href is the longest prefix of the path ("/" only matches itself). */
export function activeItem(pathname: string) {
  return allItems.filter(item => pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

// ponytail: localStorage only; the sidebar stays expanded where storage is blocked.
const SIDEBAR_KEY = "moneo-sidebar";
const subscribeSidebar = (callback: () => void) => {
  window.addEventListener("storage", callback); window.addEventListener(SIDEBAR_KEY, callback);
  return () => { window.removeEventListener("storage", callback); window.removeEventListener(SIDEBAR_KEY, callback); };
};
const sidebarCollapsed = () => { try { return localStorage.getItem(SIDEBAR_KEY) === "collapsed"; } catch { return false; } };
function setSidebarCollapsed(collapsed: boolean) {
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded"); } catch { /* storage blocked */ }
  window.dispatchEvent(new Event(SIDEBAR_KEY));
}

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || !!target.closest("dialog[open]"));

const shortcuts = [
  { keys: ["Ctrl/⌘", "K"], label: "Open command palette" },
  { keys: ["?"], label: "Show keyboard shortcuts" },
  { keys: ["["], label: "Collapse or expand sidebar" },
  ...allItems.filter(item => item.go).map(item => ({ keys: ["G", item.go!.toUpperCase()], label: `Go to ${item.label}` })),
];

function Count({ shell, href }: { shell: Promise<ShellData>; href: string }) {
  const count = use(shell)?.counts[href];
  if (!count) return null;
  return <span className="ml-auto rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground group-aria-[current=page]:bg-card">
    <span aria-hidden="true">{count > 99 ? "99+" : count}</span><span className="sr-only">, {count} pending</span>
  </span>;
}

function NavLink({ item, current, collapsed, shell, onNavigate }: { item: NavItem; current?: NavItem; collapsed?: boolean; shell: Promise<ShellData>; onNavigate?: () => void }) {
  const active = current === item, Icon = item.icon;
  return <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} title={collapsed ? item.label : undefined}
    className={cn("group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
      active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground", collapsed && "justify-center px-0")}>
    <Icon className={cn("size-4 shrink-0", active && "text-brand")} aria-hidden="true" />
    <span className={cn("truncate", collapsed && "sr-only")}>{item.label}</span>
    {!collapsed && <Suspense><Count shell={shell} href={item.href} /></Suspense>}
  </Link>;
}

function NavSections({ current, collapsed, shell, onNavigate }: { current?: NavItem; collapsed?: boolean; shell: Promise<ShellData>; onNavigate?: () => void }) {
  return sections.map(section => <div key={section.title} className="space-y-0.5">
    <p className={cn("px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground", collapsed && "sr-only")}>{section.title}</p>
    {section.items.map(item => <NavLink key={item.href} item={item} current={current} collapsed={collapsed} shell={shell} onNavigate={onNavigate} />)}
  </div>);
}

// Accounts arrive with the streamed shell data; until then the palette lists pages and actions.
function AccountCommands({ shell, base, ...props }: { shell: Promise<ShellData>; base: Command[]; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const accounts: Command[] = (use(shell)?.accounts ?? []).map(account => ({ id: `account:${account.id}`, label: account.name, group: "Accounts", keywords: "account transactions",
    run: () => router.push(`/money/transactions?account=${encodeURIComponent(account.id)}`) }));
  return <CommandPalette commands={[...base, ...accounts]} {...props} />;
}

export function AppShell({ children, shell }: { children: React.ReactNode; shell: Promise<ShellData> }) {
  const pathname = usePathname();
  const router = useRouter();
  const collapsed = useSyncExternalStore(subscribeSidebar, sidebarCollapsed, () => false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [menu, setMenu] = useState(false);
  const current = activeItem(pathname);

  useEffect(() => {
    let pendingG = 0;
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette(open => !open); return; }
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return;
      if (event.key === "?") { setHelp(true); return; }
      if (event.key === "[") { setSidebarCollapsed(!sidebarCollapsed()); return; }
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

  if (pathname === "/login") return <>{children}</>;

  const commands: Command[] = [
    { id: "new-chat", label: "New AI chat", group: "Actions", keywords: "ask conversation assistant", run: () => router.push("/ai?conversation=new") },
    { id: "import", label: "Import a statement", group: "Actions", keywords: "upload csv xlsx file", run: () => router.push("/import") },
    { id: "sidebar", label: collapsed ? "Expand sidebar" : "Collapse sidebar", group: "Actions", hint: "[", run: () => setSidebarCollapsed(!collapsed) },
    { id: "shortcuts", label: "Keyboard shortcuts", group: "Actions", hint: "?", run: () => setHelp(true) },
    ...allItems.map(item => ({ id: item.href, label: item.label, group: "Pages", keywords: sections.find(section => section.items.includes(item))?.title,
      hint: item.go && `G ${item.go.toUpperCase()}`, run: () => router.push(item.href) })),
  ];
  const paletteProps = { open: palette, onClose: () => setPalette(false) };
  const section = sections.find(section => current && section.items.includes(current))?.title;

  return <div className="min-h-screen bg-background">
    <a href="#main-content" className="sr-only z-50 rounded bg-card p-3 text-sm underline focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>
    <aside className={cn("fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border bg-sidebar transition-[width] lg:flex", collapsed ? "w-14" : "w-60")}>
      <div className={cn("flex h-14 items-center gap-2 px-3", collapsed && "justify-center")}>
        <Link href="/" className="flex min-w-0 items-center gap-2.5 rounded-md p-1" aria-label="Moneo home">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">M</span>
          {!collapsed && <span className="text-[15px] font-semibold tracking-tight">Moneo</span>}
        </Link>
        {!collapsed && <button type="button" onClick={() => setSidebarCollapsed(true)} aria-label="Collapse sidebar" title="Collapse sidebar ( [ )" className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><PanelLeftClose className="size-4" /></button>}
      </div>
      <div className="px-3 pb-2">
        <button type="button" onClick={() => setPalette(true)} aria-label="Search and commands" title="Search (Ctrl/⌘ K)"
          className={cn("flex w-full items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground", collapsed && "justify-center px-0")}>
          <Search className="size-4 shrink-0" aria-hidden="true" />{!collapsed && <><span>Search</span><span className="ml-auto flex gap-0.5"><Kbd>⌘</Kbd><Kbd>K</Kbd></span></>}
        </button>
      </div>
      <nav aria-label="Main" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-3">
        <NavSections current={current} collapsed={collapsed} shell={shell} />
      </nav>
      <div className="space-y-0.5 border-t border-border p-3">
        <NavLink item={settingsItem} current={current} collapsed={collapsed} shell={shell} />
        {collapsed && <button type="button" onClick={() => setSidebarCollapsed(false)} aria-label="Expand sidebar" title="Expand sidebar ( [ )" className="flex w-full justify-center rounded-md py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><PanelLeftOpen className="size-4" /></button>}
      </div>
    </aside>
    <div className={cn("min-w-0 pb-16 lg:pb-0", collapsed ? "lg:pl-14" : "lg:pl-60")}>
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6 lg:px-8">
        <p className="flex min-w-0 items-center gap-1.5 truncate text-sm">
          {section && <span className="hidden text-muted-foreground sm:inline">{section} /</span>}
          <span className="truncate font-medium">{current?.label ?? "Moneo"}</span>
        </p>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setPalette(true)} aria-label="Open command palette" className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"><Search className="size-[18px]" /></button>
          <AiPanel />
        </div>
      </header>
      <div id="main-content" tabIndex={-1}>{children}</div>
    </div>
    <nav aria-label="Main mobile" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      {mobileTabs.map(item => <Link key={item.href} href={item.href} aria-current={current === item ? "page" : undefined}
        className={cn("flex flex-col items-center gap-0.5 py-2 text-[11px]", current === item ? "font-medium text-foreground" : "text-muted-foreground")}>
        <item.icon className={cn("size-5", current === item && "text-brand")} aria-hidden="true" />{item.label}
      </Link>)}
      <button type="button" onClick={() => setMenu(true)} aria-haspopup="dialog" className="flex flex-col items-center gap-0.5 py-2 text-[11px] text-muted-foreground"><Menu className="size-5" aria-hidden="true" />More</button>
    </nav>
    <Modal open={menu} onClose={() => setMenu(false)} label="Navigation" className="inset-x-0 bottom-0 top-auto w-full lg:hidden">
      <nav aria-label="All pages" className="max-h-[80vh] w-full space-y-5 overflow-y-auto rounded-t-2xl border-t border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <NavSections current={current} shell={shell} onNavigate={() => setMenu(false)} />
        <div className="border-t border-border pt-3"><NavLink item={settingsItem} current={current} shell={shell} onNavigate={() => setMenu(false)} /></div>
      </nav>
    </Modal>
    {palette && <Suspense fallback={<CommandPalette commands={commands} {...paletteProps} />}><AccountCommands shell={shell} base={commands} {...paletteProps} /></Suspense>}
    <ShortcutHelp open={help} onClose={() => setHelp(false)} shortcuts={shortcuts} />
  </div>;
}
