"use client";

import { useState } from "react";

export function useBusy() {
  const [busy, setBusy] = useState(false);
  const start = (work: () => Promise<void>) => {
    setBusy(true);
    work().finally(() => setBusy(false));
  };
  return [busy, start] as const;
}
