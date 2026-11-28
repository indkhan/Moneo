import { requireWorkspace } from "@/lib/auth";
import { LOG_PAGE, listLogs, type LogFilter } from "@/lib/logs/store";
import { LogList } from "./log-list";
import { LogRetentionSetting } from "./log-retention";

export async function Logs({ filter }: { filter: LogFilter }) {
  const { supabase, workspace, settings } = await requireWorkspace();
  let entries;
  try { entries = await listLogs(supabase, workspace.id, filter, new Date()); }
  catch { return <p role="alert" className="mt-4 text-sm text-danger">Logs are unavailable. Run setup to apply database updates, then try again.</p>; }
  return <>
    <LogRetentionSetting value={settings.log_retention} />
    <LogList key={JSON.stringify(filter)} initial={entries} more={entries.length === LOG_PAGE} filter={filter} timeZone={settings.timezone} locale={workspace.locale} />
  </>;
}
