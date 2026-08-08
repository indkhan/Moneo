import { Pin, Sparkles } from "lucide-react";
import { Panel } from "./primitives";
import { compact } from "@/lib/finance-data";

const coffee = [
  { label: "May", v: 62 },
  { label: "Jun", v: 78 },
  { label: "Jul", v: 94 },
  { label: "Aug", v: 41 },
];

const subs = [
  { name: "Unused since May", items: ["Adobe CC", "Audible"], save: 34.98 },
  { name: "Price increased", items: ["Netflix", "iCloud"], save: 6.0 },
];

export function PinnedViews() {
  const max = Math.max(...coffee.map((c) => c.v));
  return (
    <div className="mt-9">
      <div className="mb-4 flex items-center gap-2">
        <Pin className="h-4 w-4 text-primary" strokeWidth={2} />
        <h2 className="text-[15px] font-bold">Pinned from AI</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
          2 views
        </span>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <Panel>
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-[15px] font-bold">Coffee habit tracker</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Sparkles className="h-3 w-3" /> “how much do I spend on coffee?”
              </p>
            </div>
            <span className="tnum rounded-full bg-accent px-2.5 py-1 text-xs font-semibold text-accent-foreground">
              -56%
            </span>
          </div>
          <div className="flex h-[120px] items-end gap-4">
            {coffee.map((c) => (
              <div key={c.label} className="flex flex-1 flex-col items-center gap-2">
                <span className="tnum text-[11px] font-semibold text-muted-foreground">
                  {compact(c.v)}
                </span>
                <div
                  className="w-full rounded-t-xl bg-primary/85"
                  style={{ height: `${(c.v / max) * 78}px` }}
                />
                <span className="text-[11px] text-muted-foreground">{c.label}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <div className="mb-4">
            <p className="text-[15px] font-bold">Subscription audit</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="h-3 w-3" /> “find subscriptions I don’t use”
            </p>
          </div>
          <div className="space-y-3">
            {subs.map((s) => (
              <div key={s.name} className="rounded-2xl bg-muted/60 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">{s.name}</p>
                  <p className="tnum text-sm font-bold text-positive">{compact(s.save)}/mo</p>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.items.map((i) => (
                    <span
                      key={i}
                      className="rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium"
                    >
                      {i}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}