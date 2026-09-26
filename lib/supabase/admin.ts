import { createClient } from "@supabase/supabase-js";

// Service-role client — server only. Never import from client components.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase admin keys missing. Add them to .env (see .env.example).");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
