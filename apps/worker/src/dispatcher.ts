/** Run one outbox batch at a time, retrying on the next tick after failures. */
export function startOutboxDispatcher(
  dispatch: () => Promise<unknown>,
  onError: (error: unknown) => void,
  intervalMs = 1000,
): () => void {
  const state = { stopped: false };
  let timer: ReturnType<typeof setTimeout>;
  const tick = async (): Promise<void> => {
    if (state.stopped) return;
    try {
      await dispatch();
    } catch (error) {
      onError(error);
    }
    timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), 0);
  return () => {
    state.stopped = true;
    clearTimeout(timer);
  };
}
