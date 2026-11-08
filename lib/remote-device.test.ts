import { expect, it } from "vitest";
import { fromRemoteDevice } from "./remote-device";

it("recognizes a device coming in over Tailscale and nothing else", () => {
  expect(fromRemoteDevice(new Headers({ host: "pc.example.ts.net" }))).toBe(true);
  expect(fromRemoteDevice(new Headers({ host: "127.0.0.1:3000", "x-forwarded-host": "PC.example.ts.net:443" }))).toBe(true);
  for (const host of ["localhost:3000", "127.0.0.1:3000", "notts.net"]) expect(fromRemoteDevice(new Headers({ host }))).toBe(false);
  expect(fromRemoteDevice(new Headers())).toBe(false);
});
