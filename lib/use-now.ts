import { useState } from "react";
import { usePolling } from "@/lib/use-polling";

export function useNow(ms: number, active = true) {
  const [now, setNow] = useState(() => Date.now());
  usePolling(() => setNow(Date.now()), ms, active, { immediate: true });
  return now;
}
