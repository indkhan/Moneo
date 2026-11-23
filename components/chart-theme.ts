"use client";

import { useMemo, useSyncExternalStore } from "react";

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function token(name: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || fallback;
}

export function useThemeColors() {
  const theme = useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme ?? "light", () => "light");
  return useMemo(() => {
    const fallback = theme === "dark" ? { brand: "#cbf26b", muted: "#a3a39e", border: "#24262a", card: "#16171a", input: "#3987e5", output: "#d95926", out: "#5b5d62", foreground: "#eeece6" } : { brand: "#4a6400", muted: "#5c5d58", border: "#e2e0d8", card: "#ffffff", input: "#2a78d6", output: "#eb6834", out: "#a9aaa3", foreground: "#141413" };
    return { brand: token("--color-brand", fallback.brand), muted: token("--color-muted-foreground", fallback.muted), border: token("--color-border", fallback.border), card: token("--color-card", fallback.card), input: token("--color-chart-input", fallback.input), output: token("--color-chart-output", fallback.output), out: token("--color-chart-out", fallback.out), foreground: token("--color-foreground", fallback.foreground) };
  }, [theme]);
}
