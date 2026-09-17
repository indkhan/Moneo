// E00-S05 identity proof: application session vs provider SSO logout.
//
// Encodes architecture §426 and the live Auth0 session-layers documentation:
// three separate layers (application, Auth0/SSO, IdP). Revoking the SSO layer
// alone does NOT invalidate an issued application cookie; the application must
// check its own server-side session record on every request. Pure logic, no
// network, no secrets. Live behavior stays Blocked until test credentials
// exist (see REPORT.md); deterministic cases live in test/identity.test.ts.

export interface SessionState {
  // Whether the application still considers its own session record valid.
  appSessionValid: boolean;
  // Whether the Auth0/SSO layer session is still alive (irrelevant to the
  // validity of an already-issued application cookie).
  ssoSessionAlive: boolean;
}

export type AccessVerdict = "allow" | "deny-stale-session";

// Server-side check for an incoming request bearing an application cookie.
export function evaluateRequest(state: SessionState): AccessVerdict {
  if (!state.appSessionValid) {
    return "deny-stale-session";
  }
  return "allow";
}

// Application-layer logout/revocation: clears the server-side record first.
export function applyAppRevocation(state: SessionState): SessionState {
  return { ...state, appSessionValid: false };
}

// Provider SSO logout (redirect to the Auth0 logout endpoint): clears only
// the SSO layer. A copied old application cookie MUST still be denied only
// if the application record was revoked — SSO logout alone changes nothing
// about already-issued application cookies.
export function applySsoLogout(state: SessionState): SessionState {
  return { ...state, ssoSessionAlive: false };
}

export const FRESH_SESSION: SessionState = {
  appSessionValid: true,
  ssoSessionAlive: true,
};
