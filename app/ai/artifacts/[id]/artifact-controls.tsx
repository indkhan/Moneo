"use client";

import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { ChevronDown, Minimize2, Pencil } from "lucide-react";
import { SafeForm } from "@/components/safe-form";
import { renameArtifactSafely } from "../actions";

export function ExitFullScreen({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") router.push(href); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [href, router]);
  return <Link href={href} autoFocus aria-label="Exit full screen" className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg border border-border px-3 hover:bg-muted"><Minimize2 className="size-3.5" aria-hidden="true" />Exit</Link>;
}

export function PendingSubmit({ className, children, ...props }: ComponentProps<"button">) {
  const { pending } = useFormStatus();
  return <button {...props} type="submit" disabled={pending} aria-busy={pending} className={`${className ?? ""} disabled:opacity-50`}>{children}</button>;
}

export function RenameArtifact({ id, title }: { id: string; title: string }) {
  return <details key={title} className="text-xs text-muted-foreground">
    <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 hover:text-foreground [&::-webkit-details-marker]:hidden"><Pencil className="size-3" aria-hidden="true" />Rename</summary>
    <SafeForm action={renameArtifactSafely} className="mt-1 flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <label className="sr-only" htmlFor="artifact-title">Artifact title</label>
      <input id="artifact-title" name="title" defaultValue={title} required maxLength={120} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground" />
      <button type="submit" className="min-h-8 rounded-lg border border-border px-3 hover:bg-muted">Save</button>
    </SafeForm>
  </details>;
}

export function BarMenu({ label, summary, children }: { label?: string; summary: ReactNode; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const details = menu.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !details.contains(event.target as Node)) details.open = false;
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", close); };
  }, []);
  return <details ref={menu} className="relative">
    <summary aria-label={label} className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-lg px-2 py-1 hover:bg-muted [&::-webkit-details-marker]:hidden">{summary}<ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" /></summary>
    <div onClick={event => { if ((event.target as HTMLElement).closest("a")) menu.current?.removeAttribute("open"); }} className="absolute right-0 top-full z-20 mt-1 grid min-w-44 gap-0.5 rounded-lg border border-border bg-card p-1 text-xs shadow-lg">{children}</div>
  </details>;
}
