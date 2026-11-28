"use client";

import { useEffect } from "react";
import { CLIENT_LOG_PATH, describeError, reportClientError } from "@/lib/client-log";

const ownApi = (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  return url.origin === window.location.origin && url.pathname.startsWith("/api/") && url.pathname !== CLIENT_LOG_PATH ? url.pathname : null;
};

export function ClientErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const { message, details } = describeError(event.error ?? event.message);
      reportClientError({ kind: "error", message, details: { ...details, source: event.filename, line: event.lineno, column: event.colno } });
    };
    const onRejection = (event: PromiseRejectionEvent) => reportClientError({ kind: "unhandledrejection", ...describeError(event.reason) });
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const path = ownApi(input);
      try {
        const response = await original(input, init);
        if (path && response.status >= 500) reportClientError({ kind: "fetch", message: `${init?.method ?? "GET"} ${path} returned ${response.status}`, details: { status: response.status } });
        return response;
      } catch (error) {
        if (path && !(error instanceof DOMException && error.name === "AbortError")) reportClientError({ kind: "fetch", message: `${init?.method ?? "GET"} ${path} failed`, details: describeError(error).details });
        throw error;
      }
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.fetch = original;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
