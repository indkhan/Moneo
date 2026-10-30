import { useEffect, useRef } from "react";

/** Calls `tick` every `ms` while `active` and the tab is visible; a hidden tab pauses and checks once on return. */
export function usePolling(tick: () => void, ms: number, active: boolean) {
  const latest = useRef(tick);
  useEffect(() => { latest.current = tick; });
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => { clearInterval(timer); timer = undefined; };
    const start = () => { if (!timer && !document.hidden) timer = setInterval(() => latest.current(), ms); };
    const onVisibility = () => { stop(); if (document.hidden) return; latest.current(); start(); };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [active, ms]);
}
