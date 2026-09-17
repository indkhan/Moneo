// E01-S02 bounded live gate: disposable Keycloak container proving browser
// Authorization Code + S256 PKCE login, pre-revocation refresh success and
// post-admin-logout refresh denial, plus non-root/read-only per-service
// secret isolation. Manual gate (needs Docker); skipped without it, never
// part of CI. Reuses the qualified E00 mechanism for the Keycloak half of
// acceptance-5; app-side revocation is proven deterministically in
// test/auth.test.ts. Keycloak logout does not propagate to app sessions
// (explicit known limitation recorded in STORIES.md E01-S02).

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { runDockerIdentityProof } from "../proof/identity/docker-proof.ts";

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { timeout: 30_000 }).status === 0;
}

describe("e01-s02 live keycloak gate", () => {
  it("containerized PKCE login/refresh/revocation behaves as E00 qualified", async () => {
    if (!dockerAvailable()) {
      console.log("SKIP: Docker unavailable for the bounded live Keycloak gate.");
      return;
    }
    const proof = await runDockerIdentityProof();
    expect(proof.authorizationCodePkce).toBe(true);
    expect(proof.login).toBe(true);
    expect(proof.refreshBeforeRevocation).toBe(true);
    expect(proof.refreshAfterRevocationDenied).toBe(true);
    expect(proof.nonRootReadOnly).toBe(true);
    expect(proof.grantedSecret).toBe(true);
    expect(proof.ungrantedSecretDenied).toBe(true);
    expect(proof.networkRemoved).toBe(true);
  }, 300_000);
});
