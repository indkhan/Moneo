import { createClient } from "@supabase/supabase-js";

// The local gateway in front of PostgREST sometimes drops a request while the database is busy
// (HTTP 502 "rest is not reachable", socket hang up, connection refused). These patterns cover
// both thrown fetch errors and the messages supabase-js turns them into.
const TRANSIENT = /is not reachable|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|fetch failed|bad gateway|service unavailable|gateway time-?out/i;
const TRANSIENT_STATUS = new Set([502, 503, 504]);

function codes(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown };
  return [...(typeof code === "string" ? [code] : []), ...codes(cause), ...(Array.isArray(errors) ? errors.flatMap(codes) : [])];
}

/** True for a dropped or refused connection to the database API, which is worth trying again. */
export function isTransientDbError(error: unknown): boolean {
  if (!error) return false;
  if (codes(error).some(code => TRANSIENT.test(code))) return true;
  const message = error instanceof Error ? `${error.message} ${codes(error).join(" ")}` : typeof error === "object" && "message" in error ? String(error.message) : String(error);
  return TRANSIENT.test(message);
}

const refused = (error: unknown) => codes(error).includes("ECONNREFUSED");
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A fetch that tries transient failures again after a short pause. Reads (GET, HEAD) are always
 * safe to repeat. A write is repeated only when the connection was refused: then nothing reached
 * PostgREST. A 502 or a dropped socket may come after PostgREST already ran the write (an RPC
 * that reserves budget, an insert), so those surface to the caller, whose step retry is idempotent.
 */
export function retryingFetch(delays: number[] = [250, 1000, 3000], base: typeof fetch = (...args) => fetch(...args)): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const read = method === "GET" || method === "HEAD";
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= delays.length || init?.signal?.aborted || init?.body instanceof ReadableStream;
      try {
        const response = await base(input, init);
        if (last || !read || !TRANSIENT_STATUS.has(response.status)) return response;
        await response.body?.cancel();
      } catch (error) {
        if (last || !(read ? isTransientDbError(error) : refused(error))) throw error;
      }
      await wait(delays[attempt]);
    }
  };
}

/** A service-role client for server code, with transient database failures retried. */
export function serviceClient(url: string, key: string) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: retryingFetch() } });
}
