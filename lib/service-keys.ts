import { createClient } from "@supabase/supabase-js";
import { decryptToken, encryptToken } from "@/lib/bank/token-crypto";

// The owner's own service keys, entered in the app and sealed in the database. A key still in
// .env keeps working while nothing is stored (older installs); a stored key wins over .env.
export const SERVICE_KEYS = {
  openai_api_key: "OPENAI_API_KEY",
  openrouter_api_key: "OPENROUTER_API_KEY",
  enable_banking_app_id: "ENABLE_BANKING_APP_ID",
  enable_banking_private_key: "ENABLE_BANKING_PRIVATE_KEY",
} as const;
export type ServiceKey = keyof typeof SERVICE_KEYS;
export type ServiceKeyStatus = { source: "app" | "env" | null; hint: string | null };

const aad = (name: ServiceKey) => `moneo:service-key:${name}`;
// Every AI call and bank request reads keys; a short cache saves the round trips, and writes clear it.
const TTL = 5_000;
let cache: { at: number; values: Partial<Record<ServiceKey, string>> } | null = null;
let warned = false;

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function stored(): Promise<Partial<Record<ServiceKey, string>>> {
  if (cache && Date.now() - cache.at < TTL) return cache.values;
  const client = db();
  if (!client) return {};
  try {
    const { data, error } = await client.from("service_keys").select("name, value_encrypted");
    if (error) throw new Error(error.message);
    const values: Partial<Record<ServiceKey, string>> = {};
    for (const row of data ?? []) if (row.name in SERVICE_KEYS) values[row.name as ServiceKey] = decryptToken(row.value_encrypted, aad(row.name as ServiceKey));
    cache = { at: Date.now(), values };
    return values;
  } catch (error) {
    // Without the table (migration not applied yet) or the database, .env still works.
    if (!warned) console.warn("Stored service keys are unavailable", error instanceof Error ? error.message : error);
    warned = true;
    return {};
  }
}

/** The key to use: the one saved in the app, else the .env value, else undefined. */
export async function serviceKey(name: ServiceKey): Promise<string | undefined> {
  return (await stored())[name] || process.env[SERVICE_KEYS[name]]?.trim() || undefined;
}

/** Where each key comes from and its last four characters, for Settings. Never the key itself. */
export async function serviceKeyStatus(): Promise<Record<ServiceKey, ServiceKeyStatus>> {
  const values = await stored();
  return Object.fromEntries(Object.entries(SERVICE_KEYS).map(([name, env]) => {
    const app = values[name as ServiceKey], fromEnv = process.env[env]?.trim();
    const value = app || fromEnv;
    return [name, { source: app ? "app" : fromEnv ? "env" : null, hint: value ? value.slice(-4) : null }];
  })) as Record<ServiceKey, ServiceKeyStatus>;
}

function requireDb() {
  const client = db();
  if (!client) throw new Error("Moneo isn't set up yet. Run npm run setup, then restart Moneo.");
  return client;
}

export async function saveServiceKeys(values: Partial<Record<ServiceKey, string>>) {
  const rows = Object.entries(values).map(([name, value]) => ({ name, value_encrypted: encryptToken(value!, aad(name as ServiceKey)), updated_at: new Date().toISOString() }));
  cache = null;
  const { error } = await requireDb().from("service_keys").upsert(rows);
  if (error) throw new Error("The key could not be saved");
}

export async function removeServiceKeys(names: ServiceKey[]) {
  cache = null;
  const { error } = await requireDb().from("service_keys").delete().in("name", names);
  if (error) throw new Error("The key could not be removed");
}
