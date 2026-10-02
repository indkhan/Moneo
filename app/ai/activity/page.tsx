import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { usageLabel, type ReportedUsage } from "@/lib/ai/usage";

type ImportRow = {
  id: string;
  filename: string;
  status: string;
  total_rows: number;
  new_rows: number;
  matched_rows: number;
  review_rows: number;
  rejected_rows: number;
  error: string | null;
  created_at: string;
};

type JobRow = {
  id: string;
  status: string;
  stage: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type SavedRow = { id: string; job_id: string; title: string; created_at: string };
type ArtifactRow = { id: string; kind: string; name: string; created_at: string };
type VersionRow = { artifact_id: string; version: number; status: string; created_at: string };
type ConversationRow = { id: string; title: string; created_at: string };

type Item = { key: string; at: string; badge: string; title: string; detail: string; href: string };

function truncate(value: string | null | undefined, max = 280) {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export default async function ActivityPage() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    redirect("/login");
  }
  const { supabase, workspace } = context;
  const [imports, jobs, saved, artifacts, versions, conversations, requests, generations] = await Promise.all([
    supabase
      .from("imports")
      .select("id, filename, status, total_rows, new_rows, matched_rows, review_rows, rejected_rows, error, created_at")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("background_jobs")
      .select("id, status, stage, error, created_at, updated_at")
      .eq("workspace_id", workspace.id)
      .eq("kind", "financial_review")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("saved_analyses")
      .select("id, job_id, title, created_at")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("artifacts")
      .select("id, kind, name, created_at")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("artifact_versions")
      .select("artifact_id, version, status, created_at")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("conversations")
      .select("id, title, created_at")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("chat_requests").select("id, conversation_id, status, error, usage, created_at, updated_at")
      .eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30),
    supabase.from("artifact_generation_requests").select("id, purpose, description, status, error, usage, created_at, updated_at")
      .eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30),
  ]);
  const errors = [generations.error, requests.error, imports.error, jobs.error, saved.error, artifacts.error, versions.error, conversations.error].filter(Boolean);
  const savedByJob = new Map<string, SavedRow>();
  for (const row of (saved.data ?? []) as SavedRow[]) savedByJob.set(row.job_id, row);
  const versionByArtifact = new Map<string, number>();
  for (const row of (versions.data ?? []) as VersionRow[]) {
    if (row.status !== "validated") continue;
    const current = versionByArtifact.get(row.artifact_id);
    if (!current || row.version > current) versionByArtifact.set(row.artifact_id, row.version);
  }

  const items: Item[] = [];
  for (const row of (imports.data ?? []) as ImportRow[]) {
    items.push({
      key: `import:${row.id}`,
      at: row.created_at,
      badge: "Import",
      title: `Import ${row.status}: ${row.filename}`,
      detail:
        `${row.new_rows} new · ${row.matched_rows} matched · ${row.review_rows} for review · ${row.rejected_rows} rejected · ${row.total_rows} total` +
        (row.status === "failed" && row.error ? ` · ${truncate(row.error, 200)}` : ""),
      href: row.review_rows > 0 ? `/import/${row.id}/review` : "/import",
    });
  }
  for (const row of (jobs.data ?? []) as JobRow[]) {
    const title = savedByJob.get(row.id)?.title;
    items.push({
      key: `analysis:${row.id}`,
      at: row.updated_at ?? row.created_at,
      badge: "Analysis",
      title: title ? `Deep Analysis ${row.status}: ${title}` : `Deep Analysis ${row.status}`,
      detail:
        `stage ${row.stage}` +
        (row.status === "failed" && row.error ? ` · ${truncate(row.error, 200)}` : ""),
      href: `/ai/activity/${row.id}`,
    });
  }
  for (const row of (artifacts.data ?? []) as ArtifactRow[]) {
    const version = versionByArtifact.get(row.id);
    items.push({
      key: `artifact:${row.id}`,
      at: row.created_at,
      badge: "Saved tool",
      title: `Saved tool: ${row.name}`,
      detail: `${row.kind.replaceAll("_", " ")}${version ? ` v${version}` : ""}`,
      href: `/ai/library/${row.id}`,
    });
  }
  for (const row of (conversations.data ?? []) as ConversationRow[]) {
    items.push({
      key: `conversation:${row.id}`,
      at: row.created_at,
      badge: "Conversation",
      title: `Conversation: ${row.title}`,
      detail: "AI chat thread",
      href: `/ai?conversation=${row.id}`,
    });
  }
  for (const row of requests.data ?? []) {
    items.push({ key: `chat:${row.id}`, at: row.updated_at, badge: "Chat", title: `Chat ${row.status}`,
      detail: `${usageLabel(row.usage as ReportedUsage | null)}${row.status === "failed" ? ` · ${truncate(row.error, 200)}` : ""}`, href: `/ai?conversation=${row.conversation_id}` });
  }
  for (const row of generations.data ?? []) {
    items.push({ key: `generation:${row.id}`, at: row.updated_at, badge: "Generation", title: `${row.purpose === "calculator" ? "Calculator draft" : "Tool proposal"} ${row.status}`,
      detail: `${truncate(row.description, 120)} · ${usageLabel(row.usage as ReportedUsage | null)}${row.status === "failed" ? ` · ${truncate(row.error, 200)}` : ""}`, href: `/ai/activity/generation/${row.id}` });
  }
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const visible = items.slice(0, 50);

  return (
    <main className="mx-auto max-w-5xl px-5 py-8 lg:px-8">
      <Link href="/ai" className="text-sm underline">
        ← AI
      </Link>
      <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-brand">AI / Activity</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">Activity</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your imports, financial reviews, saved tools, and conversations in one place.
      </p>
      {errors.length > 0 && (
        <p role="alert" className="mt-4 rounded-xl border border-border bg-card p-4 shadow-sm text-sm text-red-700">
          Could not load part of this workspace activity: {truncate(errors[0]?.message ?? "Unavailable", 200)}
        </p>
      )}
      {!errors.length && visible.length === 0 && (
        <p className="mt-6 text-muted-foreground">
          No activity yet. <Link className="underline" href="/import">Import a statement</Link> or run a
          review from <Link className="underline" href="/ai">AI</Link>.
        </p>
      )}
      {visible.length > 0 && (
        <ul className="mt-6 space-y-3">
          {visible.map((item) => (
            <li key={item.key} className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase text-muted-foreground">
                {item.badge} · {new Date(item.at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}
              </p>
              <h2 className="mt-1 font-medium">{item.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
              <Link href={item.href} className="mt-2 inline-block text-sm underline">
                Open
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
