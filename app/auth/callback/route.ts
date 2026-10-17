import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase-server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  // Only same-site paths, so the link cannot bounce users to another origin.
  const next = url.searchParams.get("next")?.match(/^\/(?!\/)/) ? url.searchParams.get("next")! : "/";
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }
  return NextResponse.redirect(new URL("/login?error=sign-in", url.origin));
}
