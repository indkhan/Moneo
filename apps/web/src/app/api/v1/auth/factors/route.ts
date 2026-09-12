import { NextResponse } from "next/server";
import { providerFromEnv, resolveStrongAuthStatus } from "@/lib/strong-auth";

/**
 * GET /api/v1/auth/factors — strong-auth enrollment status (Issue 1.8).
 * Always 200 with a state machine body (`signed-out` when logged out);
 * provider trouble surfaces as `degraded`, never as enrolled.
 */
export async function GET() {
  try {
    const status = await resolveStrongAuthStatus(providerFromEnv());
    return NextResponse.json(status);
  } catch {
    return NextResponse.json({
      state: "degraded",
      method: null,
      factors: [],
      passkeysOffered: true,
    });
  }
}
