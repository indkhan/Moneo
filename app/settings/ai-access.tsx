import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/auth";
import { chatgptStatus, setAiSource, signOut, startSignIn, type AiSource } from "@/lib/ai/chatgpt";
import { cancelClaudeSignIn, claudeAccount, claudeSignInState, ClaudeError, forgetClaudeAccount, startClaudeSignIn, submitClaudeCode } from "@/lib/ai/claude";
import { connectOnComputer, fromRemoteDevice } from "@/lib/remote-device";
import { serviceKeyStatus } from "@/lib/service-keys";
import { AiKeyForm } from "./ai-key-form";

async function signInWithChatGPT() {
  "use server";
  await requireWorkspace();
  if (fromRemoteDevice(await headers())) redirect(`/settings?chatgpt=${encodeURIComponent(connectOnComputer("ChatGPT sign-in"))}#ai-access`);
  redirect(await startSignIn(Number(process.env.PORT ?? 3000)));
}

async function signOutOfChatGPT() {
  "use server";
  await requireWorkspace();
  await signOut();
  revalidatePath("/settings");
}

async function chooseSource(form: FormData) {
  "use server";
  await requireWorkspace();
  const source = form.get("source");
  if (source === "chatgpt" || source === "claude" || source === "api_key") await setAiSource(source satisfies AiSource);
  revalidatePath("/settings");
}

const claudeBack = (message: string) => redirect(`/settings?claude=${encodeURIComponent(message)}#ai-access`);

// Claude Code's own sign-in opens the browser on the computer running Moneo, so it starts only there.
async function signInWithClaude() {
  "use server";
  await requireWorkspace();
  if (fromRemoteDevice(await headers())) claudeBack(connectOnComputer("Claude sign-in"));
  const started = await startClaudeSignIn().catch(error => ({ error: error instanceof ClaudeError ? error.message : "Claude sign-in could not start. Try again." }));
  if (started.error) claudeBack(started.error);
  revalidatePath("/settings");
}

async function finishClaudeSignIn(form: FormData) {
  "use server";
  await requireWorkspace();
  try { submitClaudeCode(String(form.get("code") ?? "")); }
  catch (error) { claudeBack(error instanceof ClaudeError ? error.message : "Claude sign-in failed. Try again."); }
  // Claude Code checks the code with Anthropic, then exits.
  for (let waited = 0; waited < 20_000 && claudeSignInState().running; waited += 250) await new Promise(resolve => setTimeout(resolve, 250));
  claudeBack(await claudeSignedInMessage());
}

/** Reads the sign-in again after it finished in the browser on its own. */
async function checkClaude() {
  "use server";
  await requireWorkspace();
  forgetClaudeAccount();
  claudeBack(await claudeSignedInMessage());
}

async function claudeSignedInMessage() {
  const failed = claudeSignInState().error;
  const account = await claudeAccount();
  if (!account.signedIn) return failed ?? account.problem ?? "Claude sign-in isn't finished yet. Finish it in the browser, or paste the code it shows.";
  cancelClaudeSignIn();
  await setAiSource("claude");
  return "connected";
}

async function cancelClaude() {
  "use server";
  await requireWorkspace();
  cancelClaudeSignIn();
  revalidatePath("/settings");
}

// Stops Moneo using Claude without signing Claude Code out, so other Claude tools keep working.
async function stopUsingClaude() {
  "use server";
  await requireWorkspace();
  await setAiSource((await chatgptStatus()).signedIn ? "chatgpt" : "api_key");
  revalidatePath("/settings");
}

const button = "min-h-10 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted";

// Three equal ways to pay for AI: the owner's ChatGPT plan, their Claude plan or an OpenAI API key, plus
// an optional OpenRouter key. Model IDs with a "/" always go to OpenRouter; voice needs the OpenAI key
// because plan usage, Claude and OpenRouter have no realtime audio. Keys are saved encrypted in the database.
export async function AiAccess({ message, claudeMessage }: { message?: string; claudeMessage?: string }) {
  const [status, keys, claude] = await Promise.all([chatgptStatus(), serviceKeyStatus(), claudeAccount()]);
  const signingIn = claudeSignInState();
  const hasKey = Boolean(keys.openai_api_key.source), hasOpenRouter = Boolean(keys.openrouter_api_key.source);
  // Choosing Claude never falls back to a paid route: while Claude Code is signed out, no AI runs.
  const active: AiSource | null = status.source === "claude" ? (claude.signedIn ? "claude" : null)
    : status.signedIn && (status.source === "chatgpt" || !hasKey) ? "chatgpt" : hasKey ? "api_key" : null;
  const option = (source: AiSource) => `rounded-lg border p-4 ${active === source ? "border-foreground" : "border-border"}`;
  return <section id="ai-access" className="scroll-mt-20 rounded-xl border border-border bg-card p-6">
    <h2 className="text-sm font-medium">AI access</h2>
    <p className="mt-1 text-sm text-muted-foreground">Use your ChatGPT plan, your Claude plan, an OpenAI API key or an OpenRouter API key for chat, insights and the agents. {active || hasOpenRouter ? "" : "None is set up yet, so AI features are off."}</p>
    {message && <p role="status" className="mt-3 text-sm">{message === "connected" ? "Signed in with ChatGPT." : message}</p>}
    {claudeMessage && <p role="status" className="mt-3 text-sm">{claudeMessage === "connected" ? "Signed in with Claude. Moneo now uses your Claude plan." : claudeMessage}</p>}
    {status.source === "claude" && !claude.signedIn && <p role="note" className="mt-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">Claude is chosen, but Claude Code isn&apos;t signed in with a Claude plan, so AI is off. Sign in with Claude again or choose another option.</p>}
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <div className={option("chatgpt")}>
        <p className="text-sm font-medium">ChatGPT plan {active === "chatgpt" && <span className="text-muted-foreground">· in use</span>}</p>
        <p className="mt-1 text-sm text-muted-foreground">{status.signedIn ? `Signed in${status.email ? ` as ${status.email}` : ""}. Requests count toward your plan's limits.` : "Sign in with a Go, Plus or Pro plan. Voice calls and dictation still need an API key."}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {status.signedIn
            ? <>{active !== "chatgpt" && <form action={chooseSource}><input type="hidden" name="source" value="chatgpt" /><button className={button}>Use ChatGPT plan</button></form>}
              <form action={signOutOfChatGPT}><button className={button}>Sign out</button></form></>
            : <form action={signInWithChatGPT}><button className={button}>Sign in with ChatGPT</button></form>}
        </div>
      </div>
      <div className={option("claude")}>
        <p className="text-sm font-medium">Claude plan {active === "claude" && <span className="text-muted-foreground">· in use</span>}</p>
        <p className="mt-1 text-sm text-muted-foreground">{claude.signedIn
          ? `Signed in${claude.email ? ` as ${claude.email}` : ""}${claude.plan ? ` (${claude.plan[0].toUpperCase()}${claude.plan.slice(1)})` : ""} through Claude Code on this computer. Requests count toward your plan's limits, never an API key.`
          : claude.installed ? "Sign in with a Pro, Max, Team or Enterprise plan through Claude Code, the same login as the Claude Code app. Voice calls and dictation still need an OpenAI API key." : claude.problem}</p>
        {signingIn.running ? <div className="mt-3 space-y-2">
          <p className="text-sm">A Claude sign-in page opened in the browser on this computer. Finish there; if the page shows a code, paste it here.</p>
          <form action={finishClaudeSignIn} className="flex flex-wrap gap-2">
            <input name="code" required autoComplete="off" spellCheck={false} aria-label="Code from the Claude sign-in page" placeholder="Paste the code" className="min-h-10 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm" />
            <button className={button}>Continue</button>
          </form>
          <div className="flex flex-wrap gap-2">
            <form action={checkClaude}><button className={button}>I&apos;ve signed in</button></form>
            <form action={cancelClaude}><button className={button}>Cancel</button></form>
            {signingIn.url && <a href={signingIn.url} target="_blank" rel="noreferrer" className={`${button} inline-flex items-center`}>Open sign-in page</a>}
          </div>
        </div> : <div className="mt-3 flex flex-wrap gap-2">
          {claude.signedIn
            ? active === "claude" ? <form action={stopUsingClaude}><button className={button}>Stop using Claude</button></form>
              : <form action={chooseSource}><input type="hidden" name="source" value="claude" /><button className={button}>Use Claude plan</button></form>
            : claude.installed && <form action={signInWithClaude}><button className={button}>Sign in with Claude</button></form>}
        </div>}
        {signingIn.error && !signingIn.running && <p role="alert" className="mt-2 text-sm text-danger">{signingIn.error}</p>}
      </div>
      <div className={option("api_key")}>
        <p className="text-sm font-medium">OpenAI API key {active === "api_key" && <span className="text-muted-foreground">· in use</span>}</p>
        <p className="mt-1 text-sm text-muted-foreground">Usage is billed to the key. Also needed for voice calls and dictation. Create one at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="underline hover:text-foreground">platform.openai.com</a>.</p>
        <AiKeyForm name="openai_api_key" label="OpenAI API key" placeholder="sk-…" status={keys.openai_api_key} />
        {hasKey && (status.signedIn || claude.signedIn) && active !== "api_key" && <form action={chooseSource} className="mt-3"><input type="hidden" name="source" value="api_key" /><button className={button}>Use API key</button></form>}
      </div>
      <div className="rounded-lg border border-border p-4">
        <p className="text-sm font-medium">OpenRouter API key <span className="font-normal text-muted-foreground">· optional</span></p>
        <p className="mt-1 text-sm text-muted-foreground">Model IDs with a <code className="rounded bg-muted px-1">/</code> (for example <code className="rounded bg-muted px-1">vendor/model</code>) run on OpenRouter. Create a key at <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="underline hover:text-foreground">openrouter.ai</a>.</p>
        <AiKeyForm name="openrouter_api_key" label="OpenRouter API key" placeholder="sk-or-…" status={keys.openrouter_api_key} />
      </div>
    </div>
    {hasOpenRouter && !hasKey && <p role="note" className="mt-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">That&apos;s fine, but voice calls and dictation need an OpenAI API key.{!status.signedIn && " Until you add one, OpenAI model IDs run through OpenRouter as openai/<model>."}</p>}
  </section>;
}
