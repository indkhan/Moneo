"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { EvidenceView } from "@/components/EvidenceView";

export default function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string>();
  const [data, setData] = useState<ComponentProps<typeof EvidenceView>["evidence"]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void params.then((value) => {
      setId(value.id);
    });
  }, [params]);
  useEffect(() => {
    if (!id) return;
    void fetch(`/api/v1/ai/evidence/${encodeURIComponent(id)}`)
      .then(async (response): Promise<unknown> => {
        if (!response.ok) throw new Error("Could not load evidence.");
        return response.json();
      })
      .then((value: unknown) => {
        setData(value as ComponentProps<typeof EvidenceView>["evidence"]);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not load evidence.");
      });
  }, [id]);
  if (error) return <div role="alert">{error}</div>;
  if (!data) return <p aria-label="Loading evidence">Loading evidence…</p>;
  return <EvidenceView evidence={data} />;
}
