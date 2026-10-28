"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

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
 * A sandboxed artifact from its frame route, in the app's current theme. Server pages pass the theme they
 * rendered, so the frame is in the HTML and starts loading before hydration. `fit` sizes it to the page's reported content height.
 */
export function ArtifactFrame({ src, title, theme: rendered = "system", fit = false, loading, className, style }: { src: string; title: string; theme?: Theme; fit?: boolean; loading?: "lazy"; className?: string; style?: CSSProperties }) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => rendered);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(FIT_START);
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
  const sized = fit ? { height, ...style } : style;
  return <iframe ref={frame} title={title} sandbox="allow-scripts" loading={loading} src={theme === "system" ? src : `${src}${src.includes("?") ? "&" : "?"}theme=${theme}`}
    className={`border-0 ${className ?? ""}`} style={{ colorScheme: theme === "system" ? "light dark" : theme, ...sized }} />;
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
