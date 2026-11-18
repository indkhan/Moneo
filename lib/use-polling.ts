import { useEffect, useRef } from "react";

const taskReportsItsOwnFailure = () => undefined;

type PollTask = (signal: AbortSignal) => void | Promise<void>;

export function usePolling(task: PollTask, ms: number, active: boolean, options: { immediate?: boolean } = {}) {
  const latest = useRef(task);
  useEffect(() => { latest.current = task; });
  const { immediate = false } = options;
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let running: AbortController | undefined;
    const run = () => {
      if (running) return;
      const controller = running = new AbortController();
      const release = () => { if (running === controller) running = undefined; };
      try {
        const result = latest.current(controller.signal);
        if (result) result.catch(taskReportsItsOwnFailure).finally(release); else release();
      } catch { release(); }
    };
    const stop = () => { clearInterval(timer); timer = undefined; running?.abort(); running = undefined; };
    const start = () => { if (!timer && !document.hidden) timer = setInterval(run, ms); };
    const onVisibility = () => { stop(); if (document.hidden) return; run(); start(); };
    if (immediate && !document.hidden) run();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [active, ms, immediate]);
}
