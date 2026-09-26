import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";

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

type SavedRow = { job_id: string; title: string };
type ArtifactRow = { id: string; kind: string; name: string; created_at: string };

type Notice = { key: string; at: string; title: string; detail: string; href: string };

function truncate(value: string | null | undefined, max = 280) {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export default async function NotificationsPage() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    redirect("/login");
  }
  const { supabase, workspace } = context;
  const [imports, jobs, saved, artifacts] = await Promise.all([
    supabase
      .from("imports")
      .select("id, filename, status, total_rows, new_rows, matched_rows, review_rows, rejected_rows, error, created_at")
      .eq("workspace_id", workspace.id)
      .in("status", ["completed", "failed"])
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("background_jobs")
      .select("id, status, stage, error, created_at, updated_at")
      .eq("workspace_id", workspace.id)
      .eq("kind", "financial_review")
      .in("status", ["completed", "failed"])
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("saved_analyses")
      .select("job_id, title")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("artifacts")
      .select("id, kind, name, created_at")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  const errors = [imports.error, jobs.error, saved.error, artifacts.error].filter(Boolean);
  const savedByJob = new Map<string, string>();
  for (const row of (saved.data ?? []) as SavedRow[]) savedByJob.set(row.job_id, row.title);

  const notices: Notice[] = [];
  for (const row of (imports.data ?? []) as ImportRow[]) {
    const failed = row.status === "failed";
    notices.push({
      key: `import:${row.id}`,
      at: row.created_at,
      title: failed ? `Import failed: ${row.filename}` : `Import completed: ${row.filename}`,
      detail: failed
        ? truncate(row.error ?? "Import failed", 200)
        : `${row.new_rows} new · ${row.matched_rows} matched · ${row.review_rows} for review · ${row.total_rows} total`,
      href: row.review_rows > 0 ? `/import/${row.id}/review` : "/import",
    });
  }
  for (const row of (jobs.data ?? []) as JobRow[]) {
    const title = savedByJob.get(row.id);
    const failed = row.status === "failed";
    notices.push({
      key: `analysis:${row.id}`,
      at: row.updated_at ?? row.created_at,
      title: failed
        ? "Deep Analysis failed"
        : title
          ? `Deep Analysis completed: ${title}`
          : "Deep Analysis completed",
      detail: failed ? truncate(row.error ?? "Analysis failed", 200) : `stage ${row.stage}`,
      href: `/ai/activity/${row.id}`,
    });
  }
  for (const row of (artifacts.data ?? []) as ArtifactRow[]) {
    notices.push({
      key: `artifact:${row.id}`,
      at: row.created_at,
      title: `New saved tool: ${row.name}`,
      detail: row.kind.replaceAll("_", " "),
      href: `/ai/library/${row.id}`,
    });
  }
  notices.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const visible = notices.slice(0, 30);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/" className="text-sm underline">
        ← Home
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">Notifications</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        In-app only, derived from current workspace imports, Deep Analysis runs, and saved tools. No
        email or push. Only completed/failed imports, completed/failed analyses, and saved tool
        creation currently produce notifications — no invented warnings and no raw datasets.
      </p>
      {errors.length > 0 && (
        <p role="alert" className="mt-4 rounded border p-3 text-sm text-red-700">
          Could not load part of these notifications: {truncate(errors[0]?.message ?? "Unavailable", 200)}
        </p>
      )}
      {!errors.length && visible.length === 0 && (
        <p className="mt-6 text-muted-foreground">
          No notifications yet. Completed imports, finished analyses, and newly saved tools will appear
          here.
        </p>
      )}
      {visible.length > 0 && (
        <ul className="mt-6 space-y-3">
          {visible.map((notice) => (
            <li key={notice.key} className="rounded border p-4">
              <p className="text-xs text-muted-foreground">{new Date(notice.at).toLocaleString()}</p>
              <h2 className="mt-1 font-medium">{notice.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{notice.detail}</p>
              <Link href={notice.href} className="mt-2 inline-block text-sm underline">
                Open
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
