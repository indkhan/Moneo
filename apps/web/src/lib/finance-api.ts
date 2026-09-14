import { StrongAuthError, requireStrongAuth, type StrongAuthContext } from "./strong-auth";

type FinanceSession = StrongAuthContext["session"] & { wid: string };

/** Require enrolled, live MFA before a finance route can read or mutate workspace data. */
export async function financeRoute(
  action: (session: FinanceSession) => Promise<Response>,
): Promise<Response> {
  try {
    const { session } = await requireStrongAuth();
    if (!session.wid)
      return Response.json(
        { error: "SIGNED_OUT", message: "Sign in to continue." },
        { status: 401 },
      );
    return await action({ ...session, wid: session.wid });
  } catch (error) {
    if (error instanceof StrongAuthError) {
      const status = error.code === "SIGNED_OUT" ? 401 : error.code === "DEGRADED" ? 503 : 403;
      return Response.json({ error: error.code, message: error.message }, { status });
    }
    throw error;
  }
}
