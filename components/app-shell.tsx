"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Bot, Home, Landmark, ListChecks, Settings, Upload, Wallet } from "lucide-react";
import { AiPanel } from "@/components/ai-panel";

const navigation = [
  { label: "Home", href: "/", icon: Home },
  { label: "Money", href: "/money/transactions", icon: Wallet },
  { label: "Plan", href: "/plan", icon: Landmark },
  { label: "AI", href: "/ai", icon: Bot },
  { label: "Import", href: "/import", icon: Upload },
  { label: "Activity", href: "/ai/activity", icon: ListChecks },
  { label: "Settings", href: "/settings", icon: Settings },
];

function activeSection(pathname: string) {
  if (pathname.startsWith("/settings")) return "Settings";
  if (pathname === "/notifications") return "Notifications";
  if (pathname.startsWith("/ai/activity")) return "Activity";
  if (pathname.startsWith("/ai")) return "AI";
  if (pathname.startsWith("/money")) return "Money";
  if (pathname.startsWith("/plan")) return "Plan";
  if (pathname.startsWith("/import")) return "Import";
  return "Home";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") return <>{children}</>;
  const current = activeSection(pathname);

  return <div className={`min-h-screen bg-background ${pathname === "/ai" ? "ai-evidence" : ""}`}>
    <a href="#main-content" className="sr-only z-50 rounded bg-card p-3 text-sm underline focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to content</a>
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-card lg:flex">
      <Link href="/" className="flex h-14 items-center gap-2.5 border-b border-border px-5" aria-label="Moneo home">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">M</span>
        <span className="text-sm font-bold tracking-tight">MONEO</span>
      </Link>
      <nav aria-label="Main" className="space-y-1 p-3 pt-5">
        {navigation.map(({ label, href, icon: Icon }) => <Link key={href} href={href} aria-current={current === label ? "page" : undefined} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${current === label ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
          <Icon className={`size-[18px] ${current === label ? "text-brand" : ""}`} aria-hidden="true" />{label}
        </Link>)}
      </nav>
      <div className="mt-auto border-t border-border px-5 py-4 text-xs text-muted-foreground">Personal finance workspace</div>
    </aside>
    <div className="min-w-0 lg:pl-60">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border bg-card/95 px-4 backdrop-blur sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-2 text-sm"><span className="hidden font-semibold sm:inline">Moneo</span><span className="hidden text-muted-foreground sm:inline">/</span><span className="truncate text-muted-foreground">{current}</span></div>
        <div className="flex items-center gap-2"><Link href="/notifications" aria-label="Notifications" className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><Bell className="size-[18px]" /></Link><AiPanel /></div>
      </header>
      <nav aria-label="Main mobile" className="flex gap-1 overflow-x-auto border-b border-border bg-card px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:hidden">
        {navigation.map(({ label, href, icon: Icon }) => <Link key={href} href={href} aria-current={current === label ? "page" : undefined} className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs ${current === label ? "bg-accent font-semibold text-foreground" : "text-muted-foreground"}`}><Icon className="size-4" aria-hidden="true" />{label}</Link>)}
      </nav>
      <div id="main-content" tabIndex={-1}>{children}</div>
    </div>
  </div>;
}
