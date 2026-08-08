import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Receipt,
  PiggyBank,
  LineChart,
  RefreshCw,
  Wand2,
  Settings,
  Search,
  Bell,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/transactions", label: "Transactions", icon: Receipt },
  { to: "/budgets", label: "Budgets", icon: PiggyBank },
  { to: "/investments", label: "Investments", icon: LineChart },
  { to: "/recurring", label: "Recurring", icon: RefreshCw },
] as const;

function Mark() {
  return (
    <div
      className="grid h-9 w-9 place-items-center rounded-2xl text-primary-foreground"
      style={{ background: "var(--gradient-ai)" }}
      aria-hidden
    >
      <span className="text-[15px] font-extrabold tracking-tight">L</span>
    </div>
  );
}

export function AppShell({
  children,
  title,
  subtitle,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 hidden w-[248px] flex-col border-r border-border/70 bg-sidebar px-4 py-6 lg:flex">
        <Link to="/" className="mb-8 flex items-center gap-3 px-2">
          <Mark />
          <div className="leading-tight">
            <p className="text-[15px] font-bold">Lumen</p>
            <p className="text-xs text-muted-foreground">Money, understood</p>
          </div>
        </Link>

        <nav className="flex flex-col gap-1">
          {nav.map((item) => {
            const active = pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-card text-foreground shadow-card"
                    : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                )}
              >
                <item.icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-6 px-1">
          <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Intelligence
          </p>
          <Link
            to="/ai"
            className={cn(
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all",
              pathname === "/ai"
                ? "text-primary-foreground shadow-card"
                : "text-foreground hover:bg-sidebar-accent",
            )}
            style={pathname === "/ai" ? { background: "var(--gradient-ai)" } : undefined}
          >
            <Wand2 className="h-[18px] w-[18px]" strokeWidth={1.75} />
            AI Workspace
          </Link>
        </div>

        <div className="mt-auto space-y-1">
          <div className="rounded-2xl bg-card p-4 shadow-card">
            <p className="text-xs font-semibold">Safe to spend</p>
            <p className="tnum mt-1 text-2xl font-bold">€1,284</p>
            <p className="mt-1 text-xs text-muted-foreground">until 31 August</p>
          </div>
          <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
            <Settings className="h-[18px] w-[18px]" strokeWidth={1.75} />
            Settings
          </button>
        </div>
      </aside>

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur-xl">
          <div className="mx-auto flex max-w-[1180px] items-center gap-4 px-6 py-5">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[22px] font-bold">{title}</h1>
              {subtitle ? (
                <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
              ) : null}
            </div>
            <div className="hidden items-center gap-2 rounded-full border border-border bg-card px-3.5 py-2 text-sm text-muted-foreground shadow-card md:flex">
              <Search className="h-4 w-4" strokeWidth={1.75} />
              <span>Ask anything…</span>
              <kbd className="ml-6 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold">⌘K</kbd>
            </div>
            <button className="grid h-10 w-10 place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-card transition-colors hover:text-foreground">
              <Bell className="h-[18px] w-[18px]" strokeWidth={1.75} />
            </button>
            <div className="grid h-10 w-10 place-items-center rounded-full bg-accent text-sm font-bold text-accent-foreground">
              MK
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1180px] px-6 pb-24 pt-8">{children}</main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around border-t border-border bg-card/95 px-2 py-2 backdrop-blur lg:hidden">
        {[...nav.slice(0, 3), { to: "/ai", label: "AI", icon: Wand2 }].map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              "flex flex-col items-center gap-1 rounded-xl px-4 py-1.5 text-[11px] font-medium",
              pathname === item.to ? "text-primary" : "text-muted-foreground",
            )}
          >
            <item.icon className="h-5 w-5" strokeWidth={1.75} />
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}