"use client";

import { useChat } from "@ai-sdk/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export default function AiPage() {
  const { messages, sendMessage, status } = useChat();
  const [input, setInput] = useState("");
  const loading = status === "streaming" || status === "submitted";

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-bold">AI</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        OpenRouter free model: {process.env.NEXT_PUBLIC_OPENROUTER_MODEL ?? "qwen/qwen3.8-27b:free"}
      </p>
      <div className="mt-6 space-y-4">
        {messages.map((m) => (
          <div key={m.id} className="rounded-lg border border-border p-3 text-sm">
            <p className="font-semibold">{m.role}</p>
            <p className="mt-1 whitespace-pre-wrap">
              {m.parts.map((p, i) => (p.type === "text" ? <span key={i}>{p.text}</span> : null))}
            </p>
          </div>
        ))}
      </div>
      <form
        className="mt-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) {
            sendMessage({ text: input });
            setInput("");
          }
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your money…"
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={loading}>
          {loading ? "…" : "Send"}
        </Button>
      </form>
    </main>
  );
}
