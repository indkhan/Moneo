import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Suspense } from "react";
import { Providers } from "@/components/providers";
import { AppShell, type ShellData } from "@/components/app-shell";
import { cookies } from "next/headers";
import { ThemePreference } from "@/components/theme-preference";
import { hasSupabase } from "@/lib/env";
import { requireWorkspace } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Moneo — Personal Finance Workspace",
  description: "Understand your money, plan decisions, and build reusable financial tools with AI.",
  applicationName: "Moneo",
  appleWebApp: { capable: true, title: "Moneo", statusBarStyle: "default" },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
};

// viewport-fit=cover lets env(safe-area-inset-*) report the iPhone notch and home indicator, which the mobile nav relies on.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f1011",
};

type Theme = "light" | "dark" | "system";

// Streams in after the shell so the saved theme never blocks the first paint or loading.tsx.
async function WorkspaceTheme({ fallback }: { fallback: Theme }) {
  let theme = fallback;
  try { theme = (await requireWorkspace()).settings.theme; } catch { /* signed out or no workspace: keep the cookie theme */ }
  return <ThemePreference preference={theme} />;
}

// Sidebar counts and palette accounts. Not awaited: the shell streams them in behind <Suspense>.
// ponytail: root layouts don't re-render on client navigation, so counts refresh on reload or router.refresh().
async function loadShellData(): Promise<ShellData> {
  try {
    const { supabase, workspace } = await requireWorkspace();
    const pending = (table: string) => supabase.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id);
    const [accounts, recurring, reviews, jobs] = await Promise.all([
      supabase.from("accounts").select("id, name").eq("workspace_id", workspace.id).is("archived_at", null).order("name").limit(200),
      pending("recurring_series").eq("status", "pending"),
      pending("organization_reviews").eq("status", "pending"),
      pending("background_jobs").in("status", ["queued", "running"]),
    ]);
    return {
      accounts: accounts.data ?? [],
      counts: { "/money/recurring": recurring.count ?? 0, "/money/organization": reviews.count ?? 0, "/ai/activity": jobs.count ?? 0 },
    };
  } catch { return null; }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieTheme = (await cookies()).get("moneo-theme")?.value;
  const theme: Theme = cookieTheme === "light" || cookieTheme === "dark" ? cookieTheme : "system";
  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {hasSupabase() ? <Suspense fallback={<ThemePreference preference={theme} />}><WorkspaceTheme fallback={theme} /></Suspense> : <ThemePreference preference={theme} />}
        <Providers><AppShell shell={hasSupabase() ? loadShellData() : Promise.resolve(null)}>{children}</AppShell></Providers>
      </body>
    </html>
  );
}
