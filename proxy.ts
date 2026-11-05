import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { hasSupabase } from "@/lib/env";

// Readable without a session. API routes answer 401 themselves.
const PUBLIC_PATHS = /^\/(login|reset-password|privacy|terms|auth|api|manifest\.webmanifest|robots\.txt|sitemap\.xml)(\/|$)/;

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  // Unconfigured checkouts have no backend to refresh against; let the Home
  // setup state and health endpoint describe the missing configuration.
  if (!hasSupabase()) return response;
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
  // An outage is not a signed-out user: let the page report it instead of sending them to login.
  if (data?.claims || isAuthRetryableFetchError(error) || PUBLIC_PATHS.test(request.nextUrl.pathname)) return response;
  const { pathname, search } = request.nextUrl;
  const login = new URL("/login", request.url);
  if (pathname !== "/" || search) login.searchParams.set("next", pathname + search);
  const redirect = NextResponse.redirect(login);
  response.cookies.getAll().forEach(cookie => redirect.cookies.set(cookie));
  return redirect;
}

export const config = {
  matcher: ["/((?!\\.well-known/workflow/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
