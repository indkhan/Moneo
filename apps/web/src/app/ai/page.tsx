"use client";

import { ChatWorkspace } from "@/components/ChatWorkspace";

export default function AiPage() {
  return (
    <section
      aria-labelledby="ai-heading"
      style={{ display: "grid", gap: 16, height: "calc(100vh - 96px)" }}
    >
      <h1 id="ai-heading" style={{ margin: 0, fontSize: 24 }}>
        AI
      </h1>
      <ChatWorkspace compact={false} initialContext={{ pathname: "/ai", label: "AI" }} />
    </section>
  );
}
