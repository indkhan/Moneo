export type RunState = { status: string; rerun_trigger: string | null; organize_after: string | null };

/** What Home says about the organizer's latest run: working (with a follow-up pass queued or not), or held back by a plan limit until a time. */
export function organizeRunState(run: RunState | null, now: Date) {
  const working = run?.status === "queued" || run?.status === "running";
  return {
    working,
    queued: working && !!run?.rerun_trigger,
    pausedUntil: !working && run?.organize_after && Date.parse(run.organize_after) > now.getTime() ? run.organize_after : null,
  };
}
