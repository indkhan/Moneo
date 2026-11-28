export const CLIENT_LOG_PATH = "/api/logs/client";
export const CLIENT_LOG_KINDS = ["error", "unhandledrejection", "boundary", "fetch"] as const;
export type ClientLogKind = (typeof CLIENT_LOG_KINDS)[number];
export type ClientLog = { kind: ClientLogKind; message: string; details?: Record<string, unknown> };

const MAX_REPORTS = 50;
const sent = new Set<string>();

export function describeError(error: unknown): { message: string; details: Record<string, unknown> } {
  if (error instanceof Error) return { message: error.message || error.name, details: { name: error.name, stack: error.stack?.slice(0, 4000) } };
  return { message: typeof error === "string" ? error : "Unknown error", details: {} };
}

export function reportClientError(report: ClientLog, send: (body: string) => void = sendReport) {
  const key = `${report.kind}:${report.message}`;
  if (sent.size >= MAX_REPORTS || sent.has(key)) return;
  sent.add(key);
  send(JSON.stringify({ ...report, message: report.message.slice(0, 2000), page: window.location.pathname }));
}

function sendReport(body: string) {
  if (navigator.sendBeacon?.(CLIENT_LOG_PATH, new Blob([body], { type: "application/json" }))) return;
  void fetch(CLIENT_LOG_PATH, { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(reportingIsBestEffortAndTheConsoleStillHasTheError);
}

const reportingIsBestEffortAndTheConsoleStillHasTheError = () => undefined;
