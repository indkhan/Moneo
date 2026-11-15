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
function readTheme(): Theme {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : "system";
}

export function ArtifactFrame({ src, title, loading, className, style }: { src: string; title: string; loading?: "lazy"; className?: string; style?: CSSProperties }) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => null);
  const url = theme && (theme === "system" ? src : `${src}${src.includes("?") ? "&" : "?"}theme=${theme}`);
  const [loaded, setLoaded] = useState<string | null>(null);
  const ready = !!url && loaded === url;
  return <div className={cn("relative", className)} style={style}>
    <iframe title={title} sandbox="allow-scripts" loading={loading} src={url ?? undefined} onLoad={() => { if (url) setLoaded(url); }}
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
