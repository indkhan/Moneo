"use client";

import { useRouter } from "next/navigation";
import { usePolling } from "@/lib/ai/use-polling";
import type { ArtifactBuild } from "@/lib/ai/artifact-builds";

const signature = (builds: Pick<ArtifactBuild, "id" | "status">[]) => builds.map(build => `${build.id}:${build.status}`).join();

/**
 * Builds that kept going after the user left: shown as working until they finish, then the page refreshes into the result.
 * A refresh re-renders the whole page, so it waits for a build to change; the check in between is one small request.
 */
export function ArtifactBuilds({ builds, artifactId }: { builds: ArtifactBuild[]; artifactId?: string }) {
  const router = useRouter();
  const shown = signature(builds);
  usePolling(() => void fetch(`/api/artifacts/builds${artifactId ? `?artifact=${artifactId}` : ""}`, { cache: "no-store" }).then(response => response.json())
    .then((result: { builds?: ArtifactBuild[] }) => { if (result.builds && signature(result.builds) !== shown) router.refresh(); }).catch(() => {}), 3000, builds.some(build => build.status === "running"));
  if (!builds.length) return null;
  return <ul aria-label="Builds" className="grid gap-2">{builds.map(build => <li key={build.id} role="status" className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
    {build.status === "running" ? <span className="text-muted-foreground">Building… </span> : <span className="text-danger">Build failed: {build.error ?? "Could not build the artifact"} · </span>}
    <span className="text-muted-foreground">{build.prompt}</span>
  </li>)}</ul>;
}
