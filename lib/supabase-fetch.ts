export const supabaseFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const signal = init?.signal ?? request?.signal;
  const retryable = (init?.method ?? request?.method ?? "GET").toUpperCase() === "GET"
    && new URL(request?.url ?? String(input)).pathname === "/auth/v1/user";
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    if (!retryable || signal?.aborted || !(error instanceof TypeError)) throw error;
    return fetch(input, init);
  }
  if (!retryable || signal?.aborted || response.status < 500) return response;
  await response.body?.cancel();
  return fetch(input, init);
};
