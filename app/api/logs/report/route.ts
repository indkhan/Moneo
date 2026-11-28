import { requireWorkspace } from "@/lib/auth";
import { redactEntries, reportText } from "@/lib/logs/redact";
import { LOG_REPORT_LIMIT, knownNames, listLogs, logFilterSchema } from "@/lib/logs/store";
import { isDesktopRuntime, moneoVersion } from "@/lib/env";

export async function GET(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const filter = logFilterSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const { supabase, workspace } = context;
  const [entries, names] = await Promise.all([listLogs(supabase, workspace.id, filter, new Date(), LOG_REPORT_LIMIT), knownNames(supabase, workspace.id)]);
  const redacted = redactEntries(entries, names);
  const header = `Moneo ${moneoVersion() ?? "unknown version"} (${isDesktopRuntime() ? "desktop app" : "source installation"}) logs, ${redacted.length} entries, redacted (amounts, IBANs, account numbers, names, emails and keys removed; audio not included)`;
  return Response.json({ text: reportText(redacted, header), json: JSON.stringify({ moneo: moneoVersion(), desktop: isDesktopRuntime(), entries: redacted }, null, 2), count: redacted.length, capped: entries.length === LOG_REPORT_LIMIT },
    { headers: { "Cache-Control": "no-store" } });
}
