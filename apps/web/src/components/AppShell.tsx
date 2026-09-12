import type { ReactNode } from "react";
import { SideNav } from "./SideNav";
import { JobIndicator } from "./JobIndicator";
import { NotificationMount } from "./NotificationMount";
import { AiPanel } from "./AiPanel";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "232px minmax(0, 1fr) 320px",
        gridTemplateRows: "48px minmax(0, 1fr)",
        gridTemplateAreas: `"nav topbar topbar" "nav main ai"`,
        minHeight: "100vh",
      }}
    >
      <div style={{ gridArea: "nav", borderRight: "1px solid var(--moneo-border, #2a3442)" }}>
        <div style={{ padding: "16px 12px 0", fontWeight: 800, fontSize: 18 }}>Moneo</div>
        <SideNav />
      </div>
      <header
        style={{
          gridArea: "topbar",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          borderBottom: "1px solid var(--moneo-border, #2a3442)",
        }}
      >
        <JobIndicator />
        <NotificationMount />
      </header>
      <main style={{ gridArea: "main", padding: 24, minWidth: 0 }}>{children}</main>
      <div
        style={{
          gridArea: "ai",
          borderLeft: "1px solid var(--moneo-border, #2a3442)",
          minWidth: 0,
        }}
      >
        <AiPanel />
      </div>
    </div>
  );
}
