import { cookies } from "next/headers";
import { UPDATE_CHECKS_COOKIE } from "@/lib/app-update";
import { Suspense } from "react";
import Link from "next/link";
import { InsightSettings } from "./insights";
import { requireWorkspace } from "@/lib/auth";
import { SkeletonCard } from "@/components/skeleton";
import { AiModelSettings, GeneralSettings, InsightSwitches, VoiceSettings } from "./form";
import { SettingsAutosave } from "./autosave";
import { ResetData } from "./reset";
import { AiAccess } from "./ai-access";
import { chatgptStatus } from "@/lib/ai/chatgpt";
import { claudeAccount } from "@/lib/ai/claude";
import { serviceKeyStatus } from "@/lib/service-keys";
import { SetupSecrets } from "./setup-secrets";
import { PhoneAccessSection } from "./phone-access";
import { SETTINGS_SECTIONS } from "@/components/settings-sections";

export const metadata = { title: "Settings" };


type SearchParams = { chatgpt?: string; claude?: string };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [context, query] = await Promise.all([requireWorkspace(), searchParams]);
  const { workspace, settings } = context;
  const updateChecks = (await cookies()).get(UPDATE_CHECKS_COOKIE)?.value === "1";
  const [status, keys, claude] = await Promise.all([chatgptStatus(), serviceKeyStatus(), claudeAccount()]);
  const connections = { openai: status.signedIn || Boolean(keys.openai_api_key.source), claude: claude.signedIn, openrouter: Boolean(keys.openrouter_api_key.source) };
  return <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-8 lg:py-8">
    <div className="flex flex-col gap-1"><p className="eyebrow">Workspace</p><h1 className="page-title">Settings</h1><p className="mt-1 break-words text-sm text-muted-foreground">Changes save as you make them. Banks and Scalable are on <Link href="/money/accounts#connected" className="underline hover:text-foreground">Accounts</Link>.</p></div>
    <div className="mt-8 grid gap-8 max-lg:mt-4 max-lg:gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label="Settings sections" className="min-w-0 lg:sticky lg:top-24 lg:self-start">
        <ul className="flex flex-wrap gap-1 max-lg:flex-nowrap max-lg:gap-2 max-lg:overflow-x-auto lg:flex-col [&>li]:shrink-0">{SETTINGS_SECTIONS.map(([id, label]) => <li key={id}>
          <a href={`#${id}`} className="block rounded-md px-2.5 py-1.5 text-sm text-muted-foreground max-lg:rounded-full max-lg:border max-lg:border-border max-lg:bg-card max-lg:px-3.5 max-lg:py-2 hover:bg-muted hover:text-foreground">{label}</a>
        </li>)}</ul>
      </nav>
      <div className="min-w-0 space-y-8">
        <SetupSecrets />
        <SettingsAutosave>
          <GeneralSettings updateChecks={updateChecks} settings={settings} currency={workspace.display_currency} timeZones={[...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])]} />
          <div className="space-y-4">
            <AiAccess status={status} keys={keys} claude={claude} message={query.chatgpt} claudeMessage={query.claude} />
            <AiModelSettings settings={settings} aiSource={status.source} connections={connections} />
          </div>
          <VoiceSettings settings={settings} connections={connections} />
          <InsightSwitches settings={settings}><Suspense fallback={<SkeletonCard lines={4} />}><InsightSettings /></Suspense></InsightSwitches>
        </SettingsAutosave>
        <div id="phone" className="scroll-mt-20"><Suspense fallback={<SkeletonCard lines={2} />}><PhoneAccessSection /></Suspense></div>
        <div id="data" className="scroll-mt-20"><ResetData /></div>
      </div>
    </div>
  </main>;
}
