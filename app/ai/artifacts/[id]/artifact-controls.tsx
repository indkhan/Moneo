"use client";

import { useEffect, type ComponentProps } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Minimize2, Pencil } from "lucide-react";
import { SafeForm } from "@/components/safe-form";
import { renameArtifactSafely } from "../actions";

/** Leaves full screen by the link or by Escape, keeping the version in view. */
export function ExitFullScreen({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") router.push(href); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [href, router]);
  return <Link href={href} autoFocus aria-label="Exit full screen" className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg border border-border px-3 hover:bg-muted"><Minimize2 className="size-3.5" aria-hidden="true" />Exit</Link>;
}

/** A submit button for a server-action form that shows it is working and takes one press at a time. */
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
