import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/app-shell";
import { cookies } from "next/headers";
import { ThemePreference } from "@/components/theme-preference";
import { createClient } from "@/lib/supabase/server";
import { loadWorkspaceSettings } from "@/lib/settings";

export const metadata: Metadata = {
  title: "Moneo — Personal Finance Workspace",
  description: "Understand your money, plan decisions, and build reusable financial tools with AI.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieTheme = (await cookies()).get("moneo-theme")?.value;
  let theme: "light" | "dark" | "system" = cookieTheme === "light" || cookieTheme === "dark" ? cookieTheme : "system";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    const { data: workspace } = await supabase.from("workspaces").select("id").eq("owner_id", user.id).maybeSingle();
    if (workspace) theme = (await loadWorkspaceSettings(supabase, workspace.id)).theme;
  }
  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ThemePreference preference={theme} /><Providers><AppShell>{children}</AppShell></Providers>
      </body>
    </html>
  );
}
