import { describe, expect, it } from "vitest";
import { cookieValue } from "./cookies";

describe("cookieValue", () => {
  it("parses the named cookie out of a header", () => {
    expect(cookieValue("a=1; __Host-moneo_session=sealed; b=2", "__Host-moneo_session")).toBe(
      "sealed",
    );
    expect(cookieValue(null, "__Host-moneo_session")).toBeUndefined();
    expect(cookieValue(undefined, "__Host-moneo_session")).toBeUndefined();
    expect(cookieValue("", "__Host-moneo_session")).toBeUndefined();
    expect(cookieValue("a=1", "__Host-moneo_session")).toBeUndefined();
    expect(cookieValue("novalue; a=1", "a")).toBe("1");
  });

  it("decodes percent-encoded values and trims whitespace", () => {
    expect(cookieValue("a=hello%20world", "a")).toBe("hello world");
    expect(cookieValue("  a  =  1  ; b=2", "a")).toBe("1");
  });

  it("matches names exactly, not by prefix", () => {
    expect(cookieValue("a-long=1; a=2", "a")).toBe("2");
  });
});
