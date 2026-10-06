import { z } from "zod";

// Validates server env. Call lazily so the homepage renders even before keys are set.
const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().default("qwen/qwen3.8-27b:free"),
  NEXT_PUBLIC_APP_URL: z.string().default("http://localhost:3000"),
});

export type Env = z.infer<typeof serverSchema>;

export function getEnv(): Env {
  return serverSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || undefined,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || undefined,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || undefined,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });
}

export type SupabaseConfigStatus = "configured" | "missing" | "partial" | "invalid";

export interface SupabaseConfig {
  status: SupabaseConfigStatus;
  detail: string;
}

// Shared runtime check for the public Supabase configuration. Reads only the
// public variable names/presence and never logs secret values.
export function getSupabaseConfig(): SupabaseConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url && !key) {
    return {
      status: "missing",
      detail: "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env to start Moneo.",
    };
  }
  if (!url || !key) {
    const missing = !url ? "NEXT_PUBLIC_SUPABASE_URL" : "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";
    return {
      status: "partial",
      detail: `Supabase configuration is incomplete. Missing ${missing}; set both NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.`,
    };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    return {
      status: "invalid",
      detail: "NEXT_PUBLIC_SUPABASE_URL must be a valid http(s) URL, for example https://xyzcompany.supabase.co.",
    };
  }
  return { status: "configured", detail: "Supabase configuration is present." };
}

export function hasSupabase() {
  return getSupabaseConfig().status === "configured";
}

export function hasOpenRouter() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}
