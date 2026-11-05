"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArtifactThumbnail } from "@/components/artifact-frame";
import { CardView } from "@/components/cards/card-view";
import type { RenderedCard } from "@/lib/cards/render";
import { usePolling } from "@/lib/ai/use-polling";

export function ArtifactPreview({ id, title, hasPage, building }: { id: string; title: string; hasPage: boolean; building: boolean }) {
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [preview, setPreview] = useState<(RenderedCard & { legacy: boolean; version: number }) | null>(null);
  const [failed, setFailed] = useState(false);
  usePolling(() => router.refresh(), 3000, building);
  useEffect(() => {
    if (!hasPage || !box.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setNear(true); observer.disconnect(); } }, { rootMargin: "200px" });
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [hasPage]);
  useEffect(() => {
    if (!near || !hasPage) return;
    let active = true;
    fetch(`/api/artifacts/${id}`, { cache: "no-store" }).then(response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(body => { if (active) { setPreview(body); setFailed(false); } }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [near, hasPage, id, building]);
  if (hasPage) return <div ref={box}>{preview ? <ArtifactThumbnail src={`/ai/artifacts/${id}/frame?v=${preview.version}`} title={title}>
    {!preview.legacy && <CardView page cardId={id} title={title} size="XL" tree={preview.tree} error={preview.error} params={preview.params} scope={`c${id.replaceAll("-", "").slice(0, 12)}`} version={preview.version} />}
  </ArtifactThumbnail> : <div className="flex aspect-[8/5] items-center justify-center bg-background text-sm text-muted-foreground"><p role="status">{failed ? "Preview unavailable. Open the artifact to try again." : "Loading preview…"}</p></div>}</div>;
  return <div className="flex aspect-[8/5] items-center justify-center bg-background p-6 text-sm text-muted-foreground">
    <p role="status">{building ? "Building your artifact…" : "No page yet. The build stopped before saving one. Open it to try again."}</p>
  </div>;
}
