import { describe, expect, it } from "vitest";
import { sessionRegistryId } from "./auth-session";

describe("sessionRegistryId", () => {
  it("maps an Auth0 session id to a stable UUID", () => {
    const first = sessionRegistryId("auth0|session");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(sessionRegistryId("auth0|session")).toBe(first);
    expect(sessionRegistryId("auth0|other")).not.toBe(first);
  });
});
