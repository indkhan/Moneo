import { isDesktopRuntime, isSetupVariableSet } from "@/lib/env";
const ITEMS = [
  ["Database and services", ["SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL"]],
  ["Automatic owner sign-in", ["MONEO_OWNER_EMAIL", "MONEO_OWNER_PASSWORD"]],
  ["Encryption for saved keys and bank sessions", ["BANK_TOKEN_ENCRYPTION_KEY"]],
  ["Background jobs", ["CRON_SECRET"]],
] as const;

export function SetupSecrets() {
  const missing = ITEMS.filter(([, keys]) => !keys.every(key => isSetupVariableSet(key))).map(([label]) => label);
  if (!missing.length) return null;
  return <p role="alert" className="rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm text-warning">
    Setup is incomplete: {missing.join(", ")}. {isDesktopRuntime() ? "Quit Moneo and open it again." : <>Run <code className="rounded bg-muted px-1">npm run setup</code> again.</>}
  </p>;
}
