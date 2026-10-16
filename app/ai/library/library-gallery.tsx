"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Calculator, Compass, Gauge, Pin, PinOff, Plane, Search, Target } from "lucide-react";
import { pinArtifact, unpinArtifact } from "./actions";

export type GalleryTool = {
  id: string; kind: string; name: string; updatedAt: string; version: number | null; available: boolean;
  pinned: boolean; sdk: string[]; inputs: string[]; generated: boolean;
};

const ICONS: Record<string, typeof Calculator> = {
  spending_explorer: BarChart3, trip_planner: Plane, goal_tracker: Target,
  custom_planner: Compass, custom_tracker: Gauge, custom_report: BarChart3, custom_comparison: Calculator,
};
const FILTERS = ["All", "Pinned", "Custom", "Built-in"] as const;

export function kindLabel(kind: string) {
  const label = kind.replace(/^custom_/, "").replaceAll("_", " ");
  return label[0].toUpperCase() + label.slice(1);
}

export function LibraryGallery({ tools }: { tools: GalleryTool[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const search = useRef<HTMLInputElement>(null);

  // "/" focuses search, like other power-user lists.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || target?.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      search.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visible = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return tools.filter(tool => {
      if (filter === "Pinned" && !tool.pinned) return false;
      if (filter === "Custom" && !tool.kind.startsWith("custom_")) return false;
      if (filter === "Built-in" && tool.kind.startsWith("custom_")) return false;
      const text = [tool.name, kindLabel(tool.kind), ...tool.sdk, ...tool.inputs].join(" ").toLowerCase();
      return words.every(word => text.includes(word));
    });
  }, [tools, query, filter]);

  return <section aria-labelledby="saved-heading">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="saved-heading" className="text-lg font-semibold tracking-tight">Saved tools <span className="text-sm font-normal text-muted-foreground">{tools.length}</span></h2>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter tools" className="flex rounded-lg border border-border bg-card p-0.5 text-sm">
          {FILTERS.map(item => <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)}
            className={`rounded-md px-2.5 py-1 ${filter === item ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{item}</button>)}
        </div>
        <label className="relative">
          <span className="sr-only">Search saved tools</span>
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search  /"
            className="w-56 rounded-lg border border-border bg-card py-1.5 pl-8 pr-3 text-sm" />
        </label>
      </div>
    </div>
    {!tools.length && <p className="mt-4 rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">No tools saved yet. Start from a template, describe one, or start blank below.</p>}
    {tools.length > 0 && !visible.length && <p className="mt-4 text-sm text-muted-foreground">No tools match this search.</p>}
    <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {visible.map(tool => {
        const Icon = ICONS[tool.kind] ?? Calculator;
        return <li key={tool.id} className="group relative flex flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-brand/40">
          <div className="flex items-start gap-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-brand"><Icon className="size-4" /></span>
            <div className="min-w-0 flex-1">
              <Link href={`/ai/library/${tool.id}`} className="block truncate font-medium text-foreground after:absolute after:inset-0 after:content-['']">{tool.name}</Link>
              <p className="text-xs text-muted-foreground">{kindLabel(tool.kind)}{tool.version ? ` · v${tool.version}` : ""}{tool.available ? "" : " · unavailable"}</p>
            </div>
            <form action={tool.pinned ? unpinArtifact : pinArtifact} className="relative z-10">
              <input type="hidden" name="artifactId" value={tool.id} />
              <input type="hidden" name="returnTo" value="/ai/library" />
              <button aria-label={`${tool.pinned ? "Unpin" : "Pin"} ${tool.name} ${tool.pinned ? "from" : "to"} Home`} title={tool.pinned ? "Unpin from Home" : "Pin to Home"}
                className={`rounded-md p-1.5 hover:bg-muted ${tool.pinned ? "text-brand" : "text-muted-foreground"}`}>
                {tool.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              </button>
            </form>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
            {tool.sdk.map(operation => <span key={operation} className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">{operation}</span>)}
            {!tool.generated && <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">host view</span>}
          </div>
          <p className="mt-auto pt-3 text-xs text-muted-foreground">
            {tool.inputs.length ? `${tool.inputs.length} input${tool.inputs.length === 1 ? "" : "s"}: ${tool.inputs.slice(0, 3).join(", ")}` : "No inputs"}
            {" · "}Updated <time dateTime={tool.updatedAt}>{tool.updatedAt.slice(0, 10)}</time>
          </p>
        </li>;
      })}
    </ul>
  </section>;
}
