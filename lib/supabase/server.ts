import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseConfig } from "@/lib/env";

export async function createClient() {
  const config = getSupabaseConfig();
  if (config.status !== "configured") throw new Error(config.detail);
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch (error) {
            // Server Components are read-only; proxy.ts persists refreshed sessions.
            if (!(error instanceof Error) || !error.message.startsWith("Cookies can only be modified in a Server Action or Route Handler.")) throw error;
          }
        },
      },
    },
  );
}
