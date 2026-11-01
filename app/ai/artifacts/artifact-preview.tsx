"use client";

import { useRouter } from "next/navigation";
import { ArtifactThumbnail } from "@/components/artifact-frame";
import { usePolling } from "@/lib/ai/use-polling";

export function ArtifactPreview({ id, title, hasPage, building }: { id: string; title: string; hasPage: boolean; building: boolean }) {
  const router = useRouter();
  usePolling(() => router.refresh(), 3000, building);
  if (hasPage) return <ArtifactThumbnail src={`/ai/artifacts/${id}/frame`} title={title} />;
  return <div className="flex aspect-[8/5] items-center justify-center bg-background p-6 text-sm text-muted-foreground">
    <p role="status">{building ? "Building your artifact…" : "No page yet. Open the artifact to continue."}</p>
  </div>;
}
