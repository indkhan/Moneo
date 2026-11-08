import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { hasSupabase } from "@/lib/env";

// Self-hosted Moneo has one owner and no sign-in screen: without a session, the proxy signs the
// owner in with the login `npm run setup` wrote to .env. The app is only reachable on this computer
// and, once the owner turns on phone access, their own Tailscale devices. Tailscale marks anything
// arriving from the public internet through Funnel; that must never reach the automatic sign-in.
export async function proxy(request: NextRequest) {
  if (request.headers.has("tailscale-funnel-request")) return new NextResponse("Moneo is private to your own devices.", { status: 403 });
  let response = NextResponse.next({ request });
  // Unconfigured checkouts have no backend to refresh against; let the Home
  // setup state and health endpoint describe the missing configuration.
  // Scheduled jobs authorize with a bearer secret and need no owner session.
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
  // Refresh before rendering; route/action authorization still checks getUser.
  const { data, error } = await supabase.auth.getClaims();
  // An outage is not a signed-out owner: let the page report it.
  if (data?.claims || isAuthRetryableFetchError(error)) return response;
  const email = process.env.MONEO_OWNER_EMAIL, password = process.env.MONEO_OWNER_PASSWORD;
  // A failed sign-in leaves the request signed out; pages then show how to finish setup.
  if (email && password) await supabase.auth.signInWithPassword({ email, password });
  return response;
}

export const config = {
  // Artifact libraries are public files loaded by sandboxed pages, which send no session.
  matcher: ["/((?!\\.well-known/workflow/|artifact-lib/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
