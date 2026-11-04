"use client";

import { startTransition, useActionState, useEffect, useRef, type ReactNode } from "react";
import type { SafeState } from "@/lib/safe-action";

/**
 * A form whose failure shows beside it and keeps what was typed; React's own form action would clear the fields either way.
 * Fields clear only after a save that went through.
 */
export function SafeForm({ action, className, children }: { action: (state: SafeState, form: FormData) => Promise<SafeState>; className?: string; children: ReactNode }) {
  const [state, submit, pending] = useActionState(action, {});
  const form = useRef<HTMLFormElement>(null);
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && !state.error) form.current?.reset();
    wasPending.current = pending;
  }, [pending, state.error]);
  return <form ref={form} className={className} onSubmit={event => {
    event.preventDefault();
    // The pressed button's name and value count, so one form can hold several choices.
    const data = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
    startTransition(() => submit(data));
  }}>
    <fieldset disabled={pending} className="contents">{children}</fieldset>
    {state.error && <p role="alert" className="basis-full text-sm text-danger sm:col-span-full">{state.error}</p>}
  </form>;
}
