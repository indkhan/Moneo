import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/auth";
import { chatgptStatus, setAiSource, signOut, startSignIn, type AiSource } from "@/lib/ai/chatgpt";

async function signInWithChatGPT() {
  "use server";
  await requireWorkspace();
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
  if (source === "chatgpt" || source === "api_key") await setAiSource(source satisfies AiSource);
  revalidatePath("/settings");
}

const button = "min-h-10 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted";

// Two equal ways to pay for AI: the owner's ChatGPT plan or an OpenAI API key. Model IDs with a
// "/" always go to OpenRouter; voice needs the API key because plan usage has no audio.
export async function AiAccess({ message }: { message?: string }) {
  const status = await chatgptStatus();
  const hasKey = Boolean(process.env.OPENAI_API_KEY);
  const active: AiSource | null = status.signedIn && (status.source === "chatgpt" || !hasKey) ? "chatgpt" : hasKey ? "api_key" : null;
  const option = (source: AiSource) => `rounded-lg border p-4 ${active === source ? "border-foreground" : "border-border"}`;
  return <section id="ai-access" className="scroll-mt-20 rounded-xl border border-border bg-card p-6">
    <h2 className="text-sm font-medium">AI access</h2>
    <p className="mt-1 text-sm text-muted-foreground">Use your ChatGPT plan or an OpenAI API key for chat, insights and the agents. {active ? "" : "Neither is set up yet, so AI features are off."}</p>
    {message && <p role="status" className="mt-3 text-sm">{message === "connected" ? "Signed in with ChatGPT." : message}</p>}
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
      <div className={option("api_key")}>
        <p className="text-sm font-medium">OpenAI API key {active === "api_key" && <span className="text-muted-foreground">· in use</span>}</p>
        <p className="mt-1 text-sm text-muted-foreground">{hasKey ? "OPENAI_API_KEY is set in .env. Usage is billed to that key." : <>Add <code className="rounded bg-muted px-1">OPENAI_API_KEY</code> to <code className="rounded bg-muted px-1">.env</code> and restart Moneo.</>}</p>
        {hasKey && status.signedIn && active !== "api_key" && <form action={chooseSource} className="mt-3"><input type="hidden" name="source" value="api_key" /><button className={button}>Use API key</button></form>}
      </div>
    </div>
  </section>;
}
