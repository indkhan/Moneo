import { Auth0Client } from "@auth0/nextjs-auth0/server";

/** Official Auth0 SDK client. OAuth, PKCE and browser sessions stay SDK-owned. */
export const auth0 = new Auth0Client({
  enableAccessTokenEndpoint: false,
});
