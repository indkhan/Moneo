import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Moneo",
  description: "AI-native personal finance workspace",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a
          href="#main-content"
          style={{
            position: "absolute",
            left: -9999,
            top: 0,
          }}
        >
          Skip to content
        </a>
        <AppShell>
          <div id="main-content">{children}</div>
        </AppShell>
      </body>
    </html>
  );
}
