"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { CALL_RECORD_EVENT, flushQueue, indexedDbStore, postCallRecord, type CallRecordEventDetail } from "@/lib/ai/voice-record-queue";
import { useTimeout } from "@/lib/use-timeout";

const RETRY_MS = 30_000, MAX_RETRIES = 5, SAVED_SHOW_MS = 8_000;

export function PendingCallRecords({ workspaceId }: { workspaceId: string }) {
  const [pending, setPending] = useState(0);
  const [saved, setSaved] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [retries, setRetries] = useState(0);
  const flushing = useRef(false);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      const result = await flushQueue(indexedDbStore, postCallRecord, workspaceId);
      setPending(result.pending);
      if (result.saved) setSaved(true);
      if (result.failures.length) setFailures(current => [...current, ...result.failures]);
      setRetries(current => result.offline && result.pending ? current + 1 : 0);
    } catch (cause) {
      setFailures(current => [...current, cause instanceof Error ? cause.message : "Moneo could not save a call record kept in this browser."]);
    } finally { flushing.current = false; }
  }, [workspaceId]);

  useEffect(() => {
    void flush();
    const onOnline = () => { setRetries(0); void flush(); };
    const onRecord = (event: Event) => {
      const detail = (event as CustomEvent<CallRecordEventDetail>).detail;
      if (detail.kind === "queued") setPending(current => current + 1);
      else setFailures(current => [...current, detail.message]);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener(CALL_RECORD_EVENT, onRecord);
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener(CALL_RECORD_EVENT, onRecord); };
  }, [flush]);

  useTimeout(() => void flush(), pending > 0 && retries > 0 && retries <= MAX_RETRIES ? RETRY_MS : null, retries);
  useTimeout(() => setSaved(false), saved ? SAVED_SHOW_MS : null);

  if (!pending && !saved && !failures.length) return null;
  return <div role="status" className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2 lg:bottom-6 lg:left-auto lg:right-6">
    {pending > 0 && <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm shadow-lg">Your call is kept on this device and will be saved when you&apos;re back online.</p>}
    {saved && !pending && <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm shadow-lg">Your call was saved.</p>}
    {failures.map((message, index) => <div key={`${index}-${message}`} className="flex items-start gap-1 rounded-xl border border-danger/30 bg-danger-soft py-1 pl-4 pr-1 text-sm text-danger shadow-lg">
      <p className="min-w-0 flex-1 py-2">{message}</p>
      <button type="button" aria-label="Dismiss" onClick={() => setFailures(current => current.filter((_, at) => at !== index))} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg hover:opacity-80"><X className="size-4" aria-hidden /></button>
    </div>)}
  </div>;
}
