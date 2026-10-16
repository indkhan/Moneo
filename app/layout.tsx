import type { Metadata } from "next";
import "./globals.css";
import { Suspense } from "react";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/app-shell";
import { cookies } from "next/headers";
import { ThemePreference } from "@/components/theme-preference";
import { hasSupabase } from "@/lib/env";
import { requireWorkspace } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Moneo — Personal Finance Workspace",
  description: "Understand your money, plan decisions, and build reusable financial tools with AI.",
};

type Theme = "light" | "dark" | "system";

// Streams in after the shell so the saved theme never blocks the first paint or loading.tsx.
async function WorkspaceTheme({ fallback }: { fallback: Theme }) {
  let theme = fallback;
  try { theme = (await requireWorkspace()).settings.theme; } catch { /* signed out or no workspace: keep the cookie theme */ }
  return <ThemePreference preference={theme} />;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieTheme = (await cookies()).get("moneo-theme")?.value;
  const theme: Theme = cookieTheme === "light" || cookieTheme === "dark" ? cookieTheme : "system";
  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {hasSupabase() ? <Suspense fallback={<ThemePreference preference={theme} />}><WorkspaceTheme fallback={theme} /></Suspense> : <ThemePreference preference={theme} />}
        <Providers><AppShell>{children}</AppShell></Providers>
      </body>
    </html>
  );
}
