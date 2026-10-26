"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

function subscribeTheme(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", notify);
  return () => { observer.disconnect(); media.removeEventListener("change", notify); };
}
function readTheme() {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const FIT_MIN = 160, FIT_MAX = 560, FIT_START = 320;

/**
 * A sandboxed artifact from its frame route, in the app's current theme. The frame is only created
 * once the theme is known, so it loads once. `fit` sizes it to the page's reported content height.
 */
export function ArtifactFrame({ src, title, fit = false, loading, className, style }: { src: string; title: string; fit?: boolean; loading?: "lazy"; className?: string; style?: CSSProperties }) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => null);
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
  if (!theme) return <div className={className} style={sized} />;
  return <iframe ref={frame} title={title} sandbox="allow-scripts" loading={loading} src={`${src}${src.includes("?") ? "&" : "?"}theme=${theme}`}
    className={`border-0 ${className ?? ""}`} style={{ colorScheme: theme, ...sized }} />;
}
