"use client";
import { useEffect, useState } from "react";

type News = { summary: string | null; detail: string | null };
type State = { status: "loading" } | { status: "ready"; news: News } | { status: "error"; message: string };

export function ScalablePositionNews({ isin }: { isin: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/scalable/news?isin=${encodeURIComponent(isin)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => ({})) as Partial<News> & { error?: string };
        setState(response.ok ? { status: "ready", news: { summary: body.summary ?? null, detail: body.detail ?? null } } : { status: "error", message: body.error ?? "Scalable could not load the news." });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ status: "error", message: "You look to be offline, so Moneo can't ask Scalable for the news." }); });
    return () => controller.abort();
  }, [isin, attempt]);
  return <section aria-labelledby="position-news" aria-busy={state.status === "loading"} className="space-y-2">
    <h3 id="position-news" className="text-xs font-medium text-muted-foreground">News from Scalable</h3>
    {state.status === "loading" && <div role="status" className="space-y-2"><span className="sr-only">Loading news…</span><div className="h-3 w-full animate-pulse rounded bg-muted" /><div className="h-3 w-4/5 animate-pulse rounded bg-muted" /></div>}
    {state.status === "ready" && (state.news.summary || state.news.detail
      ? <div className="space-y-2 text-sm">{state.news.summary && <p className="font-medium">{state.news.summary}</p>}{state.news.detail && <p className="whitespace-pre-line text-muted-foreground">{state.news.detail}</p>}</div>
      : <p className="text-sm text-muted-foreground">Scalable has no news for this security right now.</p>)}
    {state.status === "error" && <div role="alert" className="space-y-1 text-sm"><p>{state.message}</p><p className="text-xs text-muted-foreground">The chart above is from the last sync and works without a connection.</p>
      <button type="button" onClick={() => { setState({ status: "loading" }); setAttempt(count => count + 1); }} className="min-h-11 text-sm font-medium text-brand underline">Try again</button></div>}
  </section>;
}
