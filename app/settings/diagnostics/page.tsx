import { Suspense } from "react";
import Link from "next/link";
import { parseUsageWindow } from "@/lib/ai/usage";
import { SkeletonCard } from "@/components/skeleton";
import { SetupChecks } from "../setup-secrets";
import { AiUsage } from "./ai-usage";
import { AppBuild, BackendStatus, Connections, HealthCard, RecentJobs, ScheduledSummaries } from "./health";
import { DIAGNOSTICS_SECTIONS } from "./sections";

export const metadata = { title: "Diagnostics" };

const card = "rounded-xl border border-border bg-card p-6";
const link = "underline hover:text-foreground";

export default async function DiagnosticsPage({ searchParams }: { searchParams: Promise<{ usage?: string }> }) {
  const usageWindow = parseUsageWindow((await searchParams).usage);
  return <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-8 lg:py-8">
    <div className="flex flex-col gap-1">
      <p className="eyebrow"><Link href="/settings#data" className="hover:text-foreground">Settings</Link></p>
      <h1 className="page-title">Diagnostics</h1>
      <p className="mt-1 text-sm text-muted-foreground">What AI did for you and whether every part of Moneo is running.</p>
    </div>
    <nav aria-label="Diagnostics sections" className="mt-6 flex flex-wrap gap-2">
      {DIAGNOSTICS_SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} className="rounded-full border border-border bg-card px-3.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">{label}</a>)}
    </nav>
    <div className="mt-6 space-y-8">
      <section id="usage" aria-labelledby="usage-title" className={`${card} scroll-mt-20`}>
        <h2 id="usage-title" className="text-base font-semibold">AI usage</h2>
        <p className="mt-1 text-sm text-muted-foreground">Every AI call Moneo made: chat, titles, organizing, agents, artifacts, imports, reviews, voice and speech. Counts the provider did not report are left empty, not counted as zero. Moneo does not record costs: see actual charges with your provider, at <a href="https://platform.openai.com/usage" target="_blank" rel="noreferrer" className={link}>OpenAI</a>, <a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer" className={link}>Claude</a> or <a href="https://openrouter.ai/activity" target="_blank" rel="noreferrer" className={link}>OpenRouter</a>.</p>
        <Suspense fallback={<SkeletonCard lines={6} />}><AiUsage window={usageWindow} /></Suspense>
      </section>
      <section id="health" aria-labelledby="health-title" className="scroll-mt-20 space-y-4">
        <h2 id="health-title" className="text-base font-semibold">Health</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <HealthCard title="Backend services"><Suspense fallback={<SkeletonCard lines={4} />}><BackendStatus /></Suspense></HealthCard>
          <HealthCard title="Setup"><SetupChecks /><AppBuild /></HealthCard>
          <HealthCard title="Background jobs"><Suspense fallback={<SkeletonCard lines={4} />}><RecentJobs /></Suspense></HealthCard>
          <HealthCard title="Scheduled summaries"><Suspense fallback={<SkeletonCard lines={3} />}><ScheduledSummaries /></Suspense></HealthCard>
          <HealthCard title="Banks and Scalable"><Suspense fallback={<SkeletonCard lines={3} />}><Connections /></Suspense></HealthCard>
        </div>
      </section>
    </div>
  </main>;
}
