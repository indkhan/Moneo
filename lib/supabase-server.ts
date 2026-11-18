import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { supabaseClientConfig } from "@/lib/env";
import { supabaseFetch } from "@/lib/supabase-fetch";

export async function createClient() {
  const config = supabaseClientConfig();
  const cookieStore = await cookies();
  return createServerClient(
    config.url,
    config.key,
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
