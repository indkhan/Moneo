import { getSupabaseConfig, hasOpenAI, hasOpenRouter, hasSupabase } from "@/lib/env";

export async function GET() {
  const supabaseConfig = getSupabaseConfig();
  return Response.json({
    ok: true,
    supabase: hasSupabase(),
    supabaseStatus: supabaseConfig.status,
    detail: supabaseConfig.detail,
    openai: hasOpenAI(),
    openrouter: hasOpenRouter(),
  });
}
