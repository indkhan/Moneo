export type RunState = { status: string; rerun_trigger: string | null; organize_after: string | null };

export function organizeRunState(run: RunState | null, now: Date) {
  const working = run?.status === "queued" || run?.status === "running";
  return {
    working,
    queued: working && !!run?.rerun_trigger,
    pausedUntil: !working && run?.organize_after && Date.parse(run.organize_after) > now.getTime() ? run.organize_after : null,
  };
}
