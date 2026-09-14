"use client";

import { usePathname } from "next/navigation";
import { ChatWorkspace } from "./ChatWorkspace";

export function AiPanel() {
  const pathname = usePathname();
  return (
    <aside
      id="ai-panel-mount"
      aria-label="AI assistant panel"
      style={{ padding: 12, height: "100%", overflow: "auto" }}
    >
      <ChatWorkspace
        compact
        initialContext={{
          pathname,
          label: pathname === "/" ? "Home" : pathname.slice(1).replaceAll("/", " · "),
        }}
      />
    </aside>
  );
}
