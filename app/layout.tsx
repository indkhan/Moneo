import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "Moneo — Personal Finance Workspace",
  description: "Understand your money, plan decisions, and build reusable financial tools with AI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers><AppShell>{children}</AppShell></Providers>
      </body>
    </html>
  );
}
