import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthError, JwtPayload, SupabaseClient } from "@supabase/supabase-js";
import { jwtSecret } from "@/lib/env";

type Auth = Pick<SupabaseClient["auth"], "getClaims" | "getSession">;

function verifyHs256(token: string, secret: string): JwtPayload | null {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  try {
    if (JSON.parse(Buffer.from(header, "base64url").toString()).alg !== "HS256") return null;
    const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
    const given = Buffer.from(signature, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as JwtPayload;
    return typeof claims.exp === "number" && claims.exp * 1000 > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

export async function sessionClaims(auth: Auth): Promise<{ claims: JwtPayload | null; error: AuthError | null }> {
  const secret = jwtSecret();
  if (secret) {
    const { data: { session } } = await auth.getSession();
    const claims = session ? verifyHs256(session.access_token, secret) : null;
    if (claims) return { claims, error: null };
  }
  const { data, error } = await auth.getClaims();
  return { claims: data?.claims ?? null, error };
}
