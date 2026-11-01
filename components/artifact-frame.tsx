"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Skeleton } from "@/components/skeleton";
import { cn } from "@/lib/utils";

type Theme = "light" | "dark" | "system";

function subscribeTheme(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
// A "system" frame gets no theme and follows the OS itself, like the app does.
function readTheme(): Theme {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : "system";
}

const FIT_MIN = 160, FIT_MAX = 560, FIT_START = 320;

/**
 * A sandboxed artifact from its frame route, in the app's current theme. It starts loading once mounted, so it
 * loads once; a later theme change reloads it. A skeleton covers it until it has loaded.
 * `fit` sizes it to the page's reported content height.
 */
export function ArtifactFrame({ src, title, fit = false, loading, className, style }: { src: string; title: string; fit?: boolean; loading?: "lazy"; className?: string; style?: CSSProperties }) {
  // Null in the server HTML: a streamed page moves its markup into place, and moving a loading iframe restarts it.
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(FIT_START);
  const url = theme && (theme === "system" ? src : `${src}${src.includes("?") ? "&" : "?"}theme=${theme}`);
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (!fit) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const reported = Number(event.data?.moneoHeight);
      if (Number.isFinite(reported)) setHeight(Math.min(FIT_MAX, Math.max(FIT_MIN, Math.ceil(reported))));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fit]);
  const ready = !!url && loaded === url;
  return <div className={cn("relative", className)} style={fit ? { height, ...style } : style}>
    <iframe ref={frame} title={title} sandbox="allow-scripts" loading={loading} src={url ?? undefined} onLoad={() => { if (url) setLoaded(url); }}
      className="size-full border-0" style={{ colorScheme: !theme || theme === "system" ? "light dark" : theme }} />
    {!ready && <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col gap-4 overflow-hidden bg-background p-6">
      <Skeleton className="h-3 w-32" /><Skeleton className="h-8 w-56 max-w-full" />
      <div className="grid grid-cols-3 gap-3">{[0, 1, 2].map(key => <Skeleton key={key} className="h-20" />)}</div>
      <Skeleton className="min-h-24 flex-1" />
    </div>}
    {!ready && <p role="status" className="sr-only">Loading {title}…</p>}
  </div>;
}

const THUMB_WIDTH = 800, THUMB_HEIGHT = 500;

/** A scaled-down, non-interactive live preview; it only loads once scrolled near the viewport. */
export function ArtifactThumbnail({ src, title }: { src: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const element = box.current!;
    const observer = new ResizeObserver(() => setScale(element.clientWidth / THUMB_WIDTH));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={box} inert className="pointer-events-none relative aspect-[8/5] overflow-hidden bg-background">
    {scale > 0 && <ArtifactFrame src={src} title={`Preview of ${title}`} loading="lazy" className="absolute left-0 top-0 origin-top-left"
      style={{ width: THUMB_WIDTH, height: THUMB_HEIGHT, transform: `scale(${scale})` }} />}
  </div>;
}
