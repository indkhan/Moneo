import type { HTMLAttributes } from "react";

export function Skeleton({ style, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      {...rest}
      style={{
        background:
          "linear-gradient(90deg, var(--moneo-border, #2a3442) 25%, #354052 50%, var(--moneo-border, #2a3442) 75%)",
        borderRadius: 8,
        minHeight: 16,
        ...style,
      }}
    />
  );
}
