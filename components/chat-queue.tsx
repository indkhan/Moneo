import { CornerDownRight, X } from "lucide-react";
import type { QueuedMessage } from "@/lib/ai/use-chat-queue";

/** Messages waiting above the composer: each can steer the running reply or be removed. */
export function ChatQueue({ items, canSteer, onSteer, onRemove }: { items: QueuedMessage[]; canSteer: boolean; onSteer: (item: QueuedMessage) => void; onRemove: (id: string) => void }) {
  if (!items.length) return null;
  return <ul aria-label="Queued messages" className="mb-2 space-y-1">
    {items.map(item => <li key={item.id} className="flex items-center gap-2 rounded-2xl border border-border bg-card px-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1 truncate" title={item.message}>{item.message}</span>
      <button type="button" disabled={!canSteer || item.steering} onClick={() => onSteer(item)} className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
        <CornerDownRight className="size-3" aria-hidden="true" />{item.steering ? "Steering…" : "Steer"}</button>
      <button type="button" onClick={() => onRemove(item.id)} aria-label="Remove queued message" className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-3.5" aria-hidden="true" /></button>
    </li>)}
  </ul>;
}
