import { z } from "zod";

type Source = NodeJS.ProcessEnv;

const DEFAULT_PORT = 3000;
const DEFAULT_ENABLE_BANKING_API_URL = "https://api.enablebanking.com";
const DEFAULT_SCALABLE_MCP_ORIGIN = "https://mcp.scalable.capital";

const clean = (value: string | undefined) => value?.trim() || undefined;
const read = (name: string, env: Source = process.env) => clean(env[name]);

const publicAppUrl = () => clean(process.env.NEXT_PUBLIC_APP_URL);
const publicSupabaseUrl = () => clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
const publicSupabaseKey = () => clean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);

function parse<Schema extends z.ZodType>(name: string, schema: Schema, value: string | undefined): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${name} is invalid: ${result.error.issues[0]?.message ?? "unreadable value"}`);
  return result.data;
}

const portError = { error: "must be a whole number from 1 to 65535" };
const portSchema = z.coerce.number(portError).int(portError).min(1, portError).max(65535, portError).default(DEFAULT_PORT);
const urlSchema = z.string({ error: "must be set" }).url({ error: "must be a valid URL" });

export const appPort = (env: Source = process.env) => parse("PORT", portSchema, read("PORT", env));
export const loopbackUrl = (env: Source = process.env) => `http://127.0.0.1:${appPort(env)}`;
export const appUrl = () => parse("NEXT_PUBLIC_APP_URL", urlSchema.default(`http://localhost:${appPort()}`), publicAppUrl());

const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_APP_URL: z.string().default(appUrl),
});

export type Env = z.infer<typeof serverSchema>;

export function getEnv(): Env {
  return serverSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: publicSupabaseUrl(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicSupabaseKey(),
    OPENAI_API_KEY: read("OPENAI_API_KEY"),
    NEXT_PUBLIC_APP_URL: publicAppUrl(),
  });
}

export type SupabaseConfigStatus = "configured" | "missing" | "partial" | "invalid";

export interface SupabaseConfig {
  status: SupabaseConfigStatus;
  detail: string;
}

export function getSupabaseConfig(): SupabaseConfig {
  const url = publicSupabaseUrl();
  const key = publicSupabaseKey();
  if (!url && !key) {
    return {
      status: "missing",
      detail: "Moneo isn't set up yet. In the Moneo folder, run npm run setup, then restart Moneo.",
    };
  }
  if (!url || !key) {
    const missing = !url ? "NEXT_PUBLIC_SUPABASE_URL" : "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";
    return {
      status: "partial",
      detail: `Supabase configuration is incomplete. Missing ${missing}; set both NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.`,
    };
  }
  if (!/^https?:\/\//i.test(url)) {
    return {
      status: "invalid",
      detail: "NEXT_PUBLIC_SUPABASE_URL must be a valid http(s) URL, for example http://127.0.0.1:54321.",
    };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    return {
      status: "invalid",
      detail: "NEXT_PUBLIC_SUPABASE_URL must be a valid http(s) URL, for example http://127.0.0.1:54321.",
    };
  }
  return { status: "configured", detail: "Supabase configuration is present." };
}

export function hasSupabase() {
  return getSupabaseConfig().status === "configured";
}

export function supabaseClientConfig() {
  const config = getSupabaseConfig();
  const url = publicSupabaseUrl(), key = publicSupabaseKey();
  if (config.status !== "configured" || !url || !key) throw new Error(config.detail);
  return { url, key };
}

export const supabaseUrl = () => publicSupabaseUrl();
export const qaMockAi = () => read("MONEO_QA_MOCK_AI") === "1" && /^(http:\/\/(localhost|127\.0\.0\.1):54521)\/?$/.test(publicSupabaseUrl() ?? "");
export const hasServiceRoleKey = () => Boolean(read("SUPABASE_SERVICE_ROLE_KEY"));

export function serviceRoleConfig() {
  const url = publicSupabaseUrl(), key = read("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? { url, key } : null;
}

const bankTokenKeySchema = z.string({ error: "must be set" }).transform(value => Buffer.from(value, "base64")).refine(bytes => bytes.length === 32, { error: "must be 32 bytes, base64 encoded" });

export const hasBankTokenKey = () => Boolean(read("BANK_TOKEN_ENCRYPTION_KEY"));
export const bankTokenKey = () => parse("BANK_TOKEN_ENCRYPTION_KEY", bankTokenKeySchema, read("BANK_TOKEN_ENCRYPTION_KEY"));

export const jwtSecret = () => read("JWT_SECRET");

export const cronSecret = (env: Source = process.env) => read("CRON_SECRET", env);

export function ownerCredentials() {
  const email = read("MONEO_OWNER_EMAIL"), password = read("MONEO_OWNER_PASSWORD");
  return email && password ? { email, password } : null;
}

export const dataDir = () => read("MONEO_DATA_DIR") ?? `${process.cwd()}/.data`;

export const moneoVersion = () => clean(process.env.MONEO_VERSION);

export const isDesktopRuntime = () => read("MONEO_DESKTOP") === "1";
export const isDesktopPreview = () => isDesktopRuntime() && read("MONEO_DESKTOP_PREVIEW") === "1";
export const desktopBridgeUrl = () => isDesktopRuntime() && read("MONEO_DESKTOP_BRIDGE") ? parse("MONEO_DESKTOP_BRIDGE", urlSchema, read("MONEO_DESKTOP_BRIDGE")) : undefined;

export const enableBankingApiUrl = () => parse("ENABLE_BANKING_API_URL", urlSchema.default(DEFAULT_ENABLE_BANKING_API_URL), read("ENABLE_BANKING_API_URL"));
export const scalableMcpOrigin = () => parse("SCALABLE_MCP_ORIGIN", urlSchema.default(DEFAULT_SCALABLE_MCP_ORIGIN), read("SCALABLE_MCP_ORIGIN"));

export const SERVICE_KEY_VARIABLES = ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ENABLE_BANKING_APP_ID", "ENABLE_BANKING_PRIVATE_KEY"] as const;
export type ServiceKeyVariable = (typeof SERVICE_KEY_VARIABLES)[number];
export const serviceKeyFromEnv = (variable: ServiceKeyVariable) => read(variable);

export const SETUP_VARIABLES = ["SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "MONEO_OWNER_EMAIL", "MONEO_OWNER_PASSWORD", "BANK_TOKEN_ENCRYPTION_KEY", "CRON_SECRET"] as const;
export type SetupVariable = (typeof SETUP_VARIABLES)[number];
export const isSetupVariableSet = (variable: SetupVariable) => Boolean(read(variable));

export const childProcessEnv = (): NodeJS.ProcessEnv => ({ ...process.env });
