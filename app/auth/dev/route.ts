import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Local development only: signs in without the email round-trip by minting a
// magic-link token server-side. Never available in production builds.
function devSignInAllowed(request: Request) {
  return process.env.NODE_ENV === "development"
    && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
    && localHosts.has(new URL(request.url).hostname);
}

export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  if (!devSignInAllowed(request)) return new NextResponse(null, { status: 404 });
  const email = z.string().email().safeParse((await request.formData()).get("email"));
  if (!email.success) return NextResponse.redirect(new URL("/login?error=sign-in", origin), 303);
  const admin = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: email.data });
  if (!error) {
    const supabase = await createClient();
    const { error: verifyError } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: data.properties.hashed_token });
    if (!verifyError) return NextResponse.redirect(new URL("/", origin), 303);
  }
  return NextResponse.redirect(new URL("/login?error=sign-in", origin), 303);
}
