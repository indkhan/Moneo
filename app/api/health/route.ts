import { DEFAULT_OPENROUTER_MODEL, getSupabaseConfig, hasOpenRouter, hasSupabase } from "@/lib/env";

export async function GET() {
  const supabaseConfig = getSupabaseConfig();
  return Response.json({
    ok: true,
    supabase: hasSupabase(),
    supabaseStatus: supabaseConfig.status,
    detail: supabaseConfig.detail,
    openrouter: hasOpenRouter(),
    model: DEFAULT_OPENROUTER_MODEL,
  });
}
