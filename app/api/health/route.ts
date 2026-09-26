import { hasOpenRouter, hasSupabase } from "@/lib/env";

export async function GET() {
  return Response.json({
    ok: true,
    supabase: hasSupabase(),
    openrouter: hasOpenRouter(),
    model: process.env.OPENROUTER_MODEL ?? "qwen/qwen3.8-27b:free",
  });
}
