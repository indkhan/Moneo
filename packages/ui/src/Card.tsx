import type { HTMLAttributes } from "react";
import { surfaceStyle } from "./tokens.js";

export function Card({ style, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} style={surfaceStyle({ padding: "16px", ...style })} />;
}

export function CardTitle({ style, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 {...rest} style={{ margin: 0, fontSize: 16, fontWeight: 700, ...style }} />;
}

export function CardDescription({ style, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      {...rest}
      style={{ margin: "4px 0 0", color: "var(--moneo-muted, #9aa7b8)", fontSize: 13, ...style }}
    />
  );
}
