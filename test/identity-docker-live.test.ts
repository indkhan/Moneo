import { expect, it } from "vitest";

import { runDockerIdentityProof } from "../proof/identity/docker-proof.ts";

it("proves Keycloak session revocation and Docker per-service secret isolation", async () => {
  expect(await runDockerIdentityProof()).toEqual({
    keycloakImage: "quay.io/keycloak/keycloak@sha256:82a77884f3af238beab1e7afd63b5f530e1b5c0590bd7aa60b40a40463e29b2c",
    authorizationCodePkce: true,
    login: true,
    refreshBeforeRevocation: true,
    refreshAfterRevocationDenied: true,
    nonRootReadOnly: true,
    grantedSecret: true,
    ungrantedSecretDenied: true,
    networkRemoved: true,
  });
}, 180_000);
