import { getSupabaseConfig, hasSupabase } from "@/lib/env";
import { serviceKey } from "@/lib/service-keys";

export async function GET() {
  const supabaseConfig = getSupabaseConfig();
  return Response.json({
    ok: true,
    supabase: hasSupabase(),
    supabaseStatus: supabaseConfig.status,
    detail: supabaseConfig.detail,
    // Saved in the app or still in .env.
    openai: Boolean(await serviceKey("openai_api_key")),
    openrouter: Boolean(await serviceKey("openrouter_api_key")),
  });
}
