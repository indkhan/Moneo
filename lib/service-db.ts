import { createClient } from "@supabase/supabase-js";

const TRANSIENT = /is not reachable|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|fetch failed|bad gateway|service unavailable|gateway time-?out/i;
const TRANSIENT_STATUS = new Set([502, 503, 504]);

function codes(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown };
  return [...(typeof code === "string" ? [code] : []), ...codes(cause), ...(Array.isArray(errors) ? errors.flatMap(codes) : [])];
}

export function isTransientDbError(error: unknown): boolean {
  if (!error) return false;
  if (codes(error).some(code => TRANSIENT.test(code))) return true;
  const message = error instanceof Error ? `${error.message} ${codes(error).join(" ")}` : typeof error === "object" && "message" in error ? String(error.message) : String(error);
  return TRANSIENT.test(message);
}

const refused = (error: unknown) => codes(error).includes("ECONNREFUSED");
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

export function serviceClient(url: string, key: string) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: retryingFetch() } });
}
