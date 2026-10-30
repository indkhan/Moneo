"use client";

import { useRouter } from "next/navigation";
import { usePolling } from "@/lib/ai/use-polling";
import type { ArtifactBuild } from "@/lib/ai/artifact-builds";

/** Builds that kept going after the user left: shown as working until they finish, then the page refreshes into the result. */
export function ArtifactBuilds({ builds }: { builds: ArtifactBuild[] }) {
  const router = useRouter();
  usePolling(() => router.refresh(), 3000, builds.some(build => build.status === "running"));
  if (!builds.length) return null;
  return <ul aria-label="Builds" className="grid gap-2">{builds.map(build => <li key={build.id} role="status" className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
    {build.status === "running" ? <span className="text-muted-foreground">Building… </span> : <span className="text-danger">Build failed: {build.error ?? "Could not build the artifact"} · </span>}
    <span className="text-muted-foreground">{build.prompt}</span>
  </li>)}</ul>;
}
