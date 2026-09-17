import { expect, it } from "vitest";

import { runDockerIdentityProof } from "../proof/identity/docker-proof.ts";

it("proves Keycloak session revocation and Docker per-service secret isolation", async () => {
  expect(await runDockerIdentityProof()).toEqual({
    keycloakImage: "quay.io/keycloak/keycloak:26.7.4",
    login: true,
    refreshBeforeRevocation: true,
    refreshAfterRevocationDenied: true,
    nonRootReadOnly: true,
    grantedSecret: true,
    ungrantedSecretDenied: true,
  });
}, 180_000);
