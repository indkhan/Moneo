"use client";

import { useEffect, useRef } from "react";

export function FocusOnOpen({ label }: { label: string }) {
  const here = useRef<HTMLDivElement>(null);
  useEffect(() => { here.current?.focus(); }, []);
  return <div ref={here} tabIndex={-1} aria-label={label} className="outline-none" />;
}
