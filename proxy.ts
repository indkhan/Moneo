import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { hasSupabase } from "@/lib/env";

export async function proxy(request: NextRequest) {
  if (request.headers.has("tailscale-funnel-request")) return new NextResponse("Moneo is private to your own devices.", { status: 403 });
  let response = NextResponse.next({ request });
  if (!hasSupabase() || request.headers.has("authorization")) return response;
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies, headers) => {
          cookies.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
        },
      },
    },
  );
  const { data, error } = await supabase.auth.getClaims();
  if (data?.claims || isAuthRetryableFetchError(error)) return response;
  if (request.headers.has("x-moneo-test")) return new NextResponse("Browser tests need a QA session.", { status: 401 });
  const email = process.env.MONEO_OWNER_EMAIL, password = process.env.MONEO_OWNER_PASSWORD;
  if (email && password) await supabase.auth.signInWithPassword({ email, password });
  return response;
}

export const config = {
  matcher: [
    "/((?!\\.well-known/workflow/|artifact-lib/|_next/static|_next/image|favicon.ico|sw.js|offline.html|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    { source: "/.well-known/workflow/:path*", has: [{ type: "header", key: "tailscale-funnel-request" }] },
  ],
};
