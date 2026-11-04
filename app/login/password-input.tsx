"use client";

import { useState } from "react";

/** A password field that can be shown to check for typos. The toggle never submits, so password managers still fill the field. */
export function PasswordInput({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  const [shown, setShown] = useState(false);
  return <div className="relative">
    <input {...props} type={shown ? "text" : "password"} className={`${className ?? ""} pr-16`} />
    <button type="button" onClick={() => setShown(on => !on)}
      className="absolute inset-y-0 right-0 min-w-14 rounded-r-lg px-3 text-xs font-medium text-muted-foreground hover:text-foreground">{shown ? "Hide" : "Show"}<span className="sr-only"> password</span></button>
  </div>;
}
