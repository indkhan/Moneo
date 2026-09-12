import type { CSSProperties, ReactNode } from "react";

/** Product-owned design tokens. Components consume these, never raw hex. */
export const tokens = {
  color: {
    background: "var(--moneo-bg, #0f141b)",
    surface: "var(--moneo-surface, #171e28)",
    border: "var(--moneo-border, #2a3442)",
    text: "var(--moneo-text, #e8edf3)",
    muted: "var(--moneo-muted, #9aa7b8)",
    accent: "var(--moneo-accent, #4f8cff)",
  },
  radius: { sm: "6px", md: "10px", lg: "16px" },
  spacing: (n: number) => `${n * 4}px`,
} as const;

export function surfaceStyle(extra?: CSSProperties): CSSProperties {
  return {
    background: tokens.color.surface,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    color: tokens.color.text,
    ...extra,
  };
}

export type { ReactNode };
