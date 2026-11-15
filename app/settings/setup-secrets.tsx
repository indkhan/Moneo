const ITEMS = [
  ["Database and services", ["SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL"]],
  ["Automatic owner sign-in", ["MONEO_OWNER_EMAIL", "MONEO_OWNER_PASSWORD"]],
  ["Encryption for saved keys and bank sessions", ["BANK_TOKEN_ENCRYPTION_KEY"]],
  ["Background jobs", ["CRON_SECRET"]],
] as const;

export function SetupSecrets() {
  const desktop = process.env.MONEO_DESKTOP === "1";
  return <section aria-labelledby="setup-secrets" className="rounded-xl border border-border bg-card p-6">
    <h2 id="setup-secrets" className="text-sm font-medium">Set up automatically</h2>
    {desktop ? <p className="mt-1 text-sm text-muted-foreground">Moneo made these the first time it started and keeps them in its own data folder. There is nothing to set up or change here.</p>
      : <p className="mt-1 text-sm text-muted-foreground"><code className="rounded bg-muted px-1">npm run setup</code> created these in the <code className="rounded bg-muted px-1">.env</code> file next to Moneo. You don&apos;t need to open or change them; changing the database password or the encryption key makes saved data unreadable.</p>}
    <ul className="mt-3 divide-y divide-border text-sm">{ITEMS.map(([label, keys]) => {
      const ready = keys.every(key => process.env[key]);
      return <li key={label} className="flex justify-between gap-3 py-1.5">
        <span>{label}</span>
        <span className={`shrink-0 ${ready ? "text-muted-foreground" : "text-warning"}`}>{ready ? "Ready" : desktop ? "Missing: quit Moneo and open it again" : "Missing: run npm run setup"}</span>
      </li>;
    })}</ul>
  </section>;
}
