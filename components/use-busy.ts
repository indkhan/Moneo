"use client";

import { useState } from "react";

/**
 * Like useTransition for a card's own button, but done as soon as the server action answers. A transition also waits for
 * the page the action re-renders (Home's slow recurring detection), which left every button disabled and the sheet frozen.
 */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const start = (work: () => Promise<void>) => {
    setBusy(true);
    work().finally(() => setBusy(false));
  };
  return [busy, start] as const;
}
