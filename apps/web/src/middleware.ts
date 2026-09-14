import { NextResponse, type NextRequest } from "next/server";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  csrfSetCookie,
  guardMutation,
  isMutationMethod,
  issueCsrfToken,
} from "./lib/csrf";
import { applySecurityHeaders } from "./lib/security-headers";
import { auth0 } from "./lib/auth0";

/**
 * Issue 1.6 — edge middleware.
 *
 * - Safe methods: harden headers, mint the double-submit CSRF cookie when
 *   absent. GET never needs a token — and no GET handler writes server state.
 * - Mutations under `/api/*`: CSRF + Origin + Fetch-Metadata gate (403 JSON
 *   on failure), then harden headers.
 */
function appOrigin(request: NextRequest): string {
  const configured = process.env.APP_BASE_URL?.replace(/\/$/, "");
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through to the request origin below.
    }
  }
  return request.nextUrl.origin;
}

export async function middleware(request: NextRequest) {
  const isProduction = process.env.APP_ENV === "production";
  const isDevelopment = process.env.NODE_ENV === "development";
  const response = await auth0.middleware(request);

  if (request.nextUrl.pathname.startsWith("/auth/")) {
    applySecurityHeaders(response.headers, { isProduction, isDevelopment });
    return response;
  }

  if (!isMutationMethod(request.method)) {
    applySecurityHeaders(response.headers, { isProduction, isDevelopment });
    if (!request.cookies.has(CSRF_COOKIE)) {
      response.headers.append("Set-Cookie", csrfSetCookie(issueCsrfToken()));
    }
    return response;
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    const verdict = guardMutation({
      method: request.method,
      cookieToken: request.cookies.get(CSRF_COOKIE)?.value,
      headerToken: request.headers.get(CSRF_HEADER),
      origin: request.headers.get("origin"),
      referer: request.headers.get("referer"),
      secFetchSite: request.headers.get("sec-fetch-site"),
      appOrigin: appOrigin(request),
    });
    if (!verdict.allowed) {
      const denied = NextResponse.json(
        { error: "forbidden", reason: verdict.reason },
        { status: 403 },
      );
      applySecurityHeaders(denied.headers, { isProduction, isDevelopment });
      return denied;
    }
  }

  applySecurityHeaders(response.headers, { isProduction, isDevelopment });
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
