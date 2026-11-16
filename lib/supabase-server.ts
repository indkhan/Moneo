import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/lib/database";
import { getSupabaseConfig } from "@/lib/env";
import { supabaseFetch } from "@/lib/supabase-fetch";

export async function createClient() {
  const config = getSupabaseConfig();
  if (config.status !== "configured") throw new Error(config.detail);
  const cookieStore = await cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      global: { fetch: supabaseFetch },
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith("Cookies can only be modified in a Server Action or Route Handler.")) throw error;
          }
        },
      },
    },
  );
}
