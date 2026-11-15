"use client";

import { startTransition, useActionState, useEffect, useRef, type ReactNode } from "react";
import type { SafeState } from "@/lib/safe-action";

export function SafeForm({ action, className, children }: { action: (state: SafeState, form: FormData) => Promise<SafeState>; className?: string; children: ReactNode }) {
  const [state, submit, pending] = useActionState(action, {});
  const form = useRef<HTMLFormElement>(null);
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && !state.error) form.current?.reset();
    wasPending.current = pending;
  }, [pending, state.error]);
  return <form ref={form} className={className} action={submit} onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
    startTransition(() => submit(data));
  }}>
    <fieldset disabled={pending} className="contents">{children}</fieldset>
    {state.error && <p role="alert" className="basis-full text-sm text-danger sm:col-span-full">{state.error}</p>}
  </form>;
}
