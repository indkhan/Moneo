import Link from "next/link";

// Pages land here when the owner could not be signed in automatically (see proxy.ts).
export default function Login() {
  return <main className="mx-auto grid min-h-screen w-full max-w-md place-items-center px-4">
    <div className="rounded-xl border border-border bg-card p-6">
      <h1 className="text-base font-medium">Moneo could not sign you in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The database may not be running, or setup is unfinished. In the Moneo folder, run <code className="rounded bg-muted px-1">npm run setup</code>,
        then restart Moneo and reload this page.
      </p>
      <Link href="/" className="mt-4 inline-flex min-h-10 items-center rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted">Try again</Link>
    </div>
  </main>;
}
