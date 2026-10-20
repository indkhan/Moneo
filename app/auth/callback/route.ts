import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase-server";

const otpTypes = new Set<EmailOtpType>(["email", "magiclink", "signup", "recovery", "invite", "email_change"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  // Only same-site paths, so the link cannot bounce users to another origin.
  const next = url.searchParams.get("next")?.match(/^\/(?!\/)/) ? url.searchParams.get("next")! : "/";
  const supabase = await createClient();
  // token_hash links (from the email templates) verify in any browser; PKCE codes
  // only in the browser that requested the email.
  const { error } = tokenHash && type && otpTypes.has(type)
    ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    : code ? await supabase.auth.exchangeCodeForSession(code) : { error: true };
  if (!error) return NextResponse.redirect(new URL(next, url.origin));
  return NextResponse.redirect(new URL("/login?error=sign-in", url.origin));
}
