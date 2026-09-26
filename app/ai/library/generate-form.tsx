"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Proposal = {
  kind: "spending_explorer" | "trip_planner" | "goal_tracker";
  name: string;
  rationale: string;
};

const labels: Record<Proposal["kind"], string> = {
  spending_explorer: "Spending Explorer",
  trip_planner: "Trip Planner",
  goal_tracker: "Goal Tracker",
};

export function GenerateForm() {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [creating, setCreating] = useState(false);

  async function suggest() {
    setSuggesting(true);
    setStatus("");
    setProposal(null);
    try {
      const response = await fetch("/api/artifacts/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error ?? "Suggestion failed");
      setProposal(payload as Proposal);
      setName((payload as Proposal).name);
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Suggestion failed");
    } finally {
      setSuggesting(false);
    }
  }

  async function continueWithProposal() {
    if (!proposal) return;
    setCreating(true);
    setStatus("");
    try {
      const response = await fetch("/api/artifacts/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, kind: proposal.kind, name }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error ?? "Creation failed");
      router.push(`/ai/library/${payload.id}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Creation failed");
      setCreating(false);
    }
  }

  return (
    <section aria-label="AI-assisted tool suggestion" className="mt-8 rounded-lg border p-4">
      <h2 className="text-lg font-semibold">Describe a tool</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        AI suggests one trusted template. Nothing is created until you choose Continue.
      </p>
      <label className="mt-3 block text-sm font-medium" htmlFor="ai-tool-description">
        What should the tool help with?
      </label>
      <textarea
        id="ai-tool-description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        maxLength={500}
        rows={3}
        placeholder="e.g. compare dining spending this month"
        className="mt-2 w-full rounded border p-2 text-sm"
      />
      <button
        type="button"
        disabled={suggesting || description.trim().length === 0}
        onClick={suggest}
        className="mt-3 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
      >
        {suggesting ? "Suggesting…" : "Suggest a tool"}
      </button>

      {proposal && (
        <div className="mt-4 rounded border p-3 text-sm">
          <p>
            <span className="font-medium">Suggested type:</span> {labels[proposal.kind]}
          </p>
          <label className="mt-2 block font-medium" htmlFor="ai-tool-name">
            Suggested name
          </label>
          <input
            id="ai-tool-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            className="mt-1 w-full rounded border p-2"
          />
          <p className="mt-2">
            <span className="font-medium">Why:</span> {proposal.rationale}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Continue creates this trusted {labels[proposal.kind]} template in your workspace. No custom code is generated.
          </p>
          <button
            type="button"
            disabled={creating || name.trim().length === 0}
            onClick={continueWithProposal}
            className="mt-3 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {creating ? "Creating…" : "Continue – Create this tool"}
          </button>
        </div>
      )}

      {status && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {status}
        </p>
      )}
    </section>
  );
}
