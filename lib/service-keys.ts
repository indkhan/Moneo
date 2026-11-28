import "server-only";
import { createClient } from "@supabase/supabase-js";
import { decryptToken, encryptToken } from "@/lib/bank/token-crypto";
import { serviceKeyFromEnv, serviceRoleConfig, type ServiceKeyVariable } from "@/lib/env";
import { logWarn } from "@/lib/log";

export const SERVICE_KEYS = {
  openai_api_key: "OPENAI_API_KEY",
  openrouter_api_key: "OPENROUTER_API_KEY",
  enable_banking_app_id: "ENABLE_BANKING_APP_ID",
  enable_banking_private_key: "ENABLE_BANKING_PRIVATE_KEY",
} as const satisfies Record<string, ServiceKeyVariable>;
export type ServiceKey = keyof typeof SERVICE_KEYS;
export type ServiceKeyStatus = { source: "app" | "env" | null; hint: string | null };

const aad = (name: ServiceKey) => `moneo:service-key:${name}`;
const TTL = 5_000;
let cache: { at: number; values: Partial<Record<ServiceKey, string>> } | null = null;
let warned = false;

function db() {
  const config = serviceRoleConfig();
  if (!config) return null;
  return createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false } });
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
    if (!warned) logWarn("server", "stored_service_keys_are_unavailable", "Stored service keys are unavailable", error instanceof Error ? error.message : error);
    warned = true;
    return {};
  }
}

export async function serviceKey(name: ServiceKey): Promise<string | undefined> {
  return (await stored())[name] || serviceKeyFromEnv(SERVICE_KEYS[name]) || undefined;
}

export async function serviceKeyStatus(): Promise<Record<ServiceKey, ServiceKeyStatus>> {
  const values = await stored();
  return Object.fromEntries(Object.entries(SERVICE_KEYS).map(([name, env]) => {
    const app = values[name as ServiceKey], fromEnv = serviceKeyFromEnv(env);
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
