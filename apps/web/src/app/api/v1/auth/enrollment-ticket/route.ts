import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth-session";
import { providerFromEnv } from "@/lib/strong-auth";

/**
 * POST /api/v1/auth/enrollment-ticket — provider-hosted setup flow (Issue 1.8).
 *
 * Body: `{ "kind": "passkey" | "totp" }`. Returns the provider enrollment URL
 * the UI redirects to; the user comes back and the status endpoint flips to
 * enrolled (resumable setup). Passkey requests on a non-passkey tenant get a
 * 400 naming the TOTP fallback. A mutation, so the edge CSRF gate applies.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const kind =
    typeof body === "object" && body !== null ? (body as { kind?: unknown }).kind : undefined;
  if (kind !== "passkey" && kind !== "totp") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const provider = providerFromEnv();
    if (kind === "passkey" && !provider.passkeysOffered()) {
      return NextResponse.json({ error: "passkey_unsupported", fallback: "totp" }, { status: 400 });
    }
    const { ticketUrl } = await provider.enrollmentTicket(session.sub);
    return NextResponse.json({ ticketUrl });
  } catch {
    return NextResponse.json({ error: "provider_unavailable" }, { status: 502 });
  }
}
