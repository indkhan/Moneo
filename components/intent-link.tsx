"use client";

import Link from "next/link";
import { useRef, useState, type ComponentProps } from "react";

export function IntentLink({ onPointerEnter, onPointerLeave, onFocus, onBlur, onTouchStart, ...props }: ComponentProps<typeof Link>) {
  const [intent, setIntent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const current = props["aria-current"] === "page";
  const show = () => { if (!current) setIntent(true); };
  const hide = () => { clearTimeout(timer.current); setIntent(false); };
  return <Link {...props} prefetch={intent ? true : null}
    onPointerEnter={event => { onPointerEnter?.(event); clearTimeout(timer.current); timer.current = setTimeout(show, 60); }}
    onPointerLeave={event => { onPointerLeave?.(event); hide(); }}
    onFocus={event => { onFocus?.(event); show(); }}
    onBlur={event => { onBlur?.(event); hide(); }}
    onTouchStart={event => { onTouchStart?.(event); show(); }} />;
}
