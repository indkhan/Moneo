"use client";

import { useEffect, useRef } from "react";

/** Moves focus here when it appears, so keyboard and screen-reader users land inside what just opened. */
export function FocusOnOpen({ label }: { label: string }) {
  const here = useRef<HTMLDivElement>(null);
  useEffect(() => { here.current?.focus(); }, []);
  return <div ref={here} tabIndex={-1} aria-label={label} className="outline-none" />;
}
