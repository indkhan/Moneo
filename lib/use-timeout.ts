import { useCallback, useEffect, useRef } from "react";

export function useTimeout(callback: () => void, delayMs: number | null, restartKey?: unknown) {
  const latest = useRef(callback);
  useEffect(() => { latest.current = callback; });
  useEffect(() => {
    if (delayMs === null) return;
    const timer = setTimeout(() => latest.current(), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, restartKey]);
}

export function useDelay() {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancel = useCallback(() => clearTimeout(timer.current), []);
  useEffect(() => cancel, [cancel]);
  const after = useCallback((run: () => void, delayMs: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(run, delayMs);
  }, []);
  return [after, cancel] as const;
}
