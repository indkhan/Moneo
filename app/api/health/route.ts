import { getSupabaseConfig, hasOpenRouter, hasSupabase } from "@/lib/env";

export async function GET() {
  const supabaseConfig = getSupabaseConfig();
  return Response.json({
    ok: true,
    supabase: hasSupabase(),
    supabaseStatus: supabaseConfig.status,
    detail: supabaseConfig.detail,
    openrouter: hasOpenRouter(),
    model: process.env.OPENROUTER_MODEL ?? "qwen/qwen3.8-27b:free",
  });
}
