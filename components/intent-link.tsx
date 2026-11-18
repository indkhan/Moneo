"use client";

import Link from "next/link";
import { useState, type ComponentProps } from "react";
import { useDelay } from "@/lib/use-timeout";

export function IntentLink({ onPointerEnter, onPointerLeave, onFocus, onBlur, onTouchStart, ...props }: ComponentProps<typeof Link>) {
  const [intent, setIntent] = useState(false);
  const [later, cancelLater] = useDelay();
  const current = props["aria-current"] === "page";
  const show = () => { if (!current) setIntent(true); };
  const hide = () => { cancelLater(); setIntent(false); };
  return <Link {...props} prefetch={intent ? true : null}
    onPointerEnter={event => { onPointerEnter?.(event); later(show, 60); }}
    onPointerLeave={event => { onPointerLeave?.(event); hide(); }}
    onFocus={event => { onFocus?.(event); show(); }}
    onBlur={event => { onBlur?.(event); hide(); }}
    onTouchStart={event => { onTouchStart?.(event); show(); }} />;
}
