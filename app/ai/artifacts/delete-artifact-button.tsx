"use client";

import { Trash2 } from "lucide-react";
import { deleteArtifact } from "./actions";

/** Asks first, like deleting a chat; the artifact is soft-deleted and its versions are kept. */
export function DeleteArtifactButton({ id, title, className = "", label = "Delete artifact" }: { id: string; title: string; className?: string; label?: string }) {
  return <form action={deleteArtifact.bind(null, id)} className={className}
    onSubmit={event => { if (!window.confirm(`Delete “${title}”? It leaves your artifacts and Home. Its versions are kept.`)) event.preventDefault(); }}>
    <button type="submit" aria-label={label ? undefined : `Delete ${title}`} className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg text-xs text-muted-foreground hover:text-danger lg:min-h-8 lg:min-w-8">
      <Trash2 className="size-3.5" aria-hidden="true" />{label}</button>
  </form>;
}
