import { expect, it } from "vitest";
import { fromRemoteDevice, requestOrigin } from "./remote-device";

it("recognizes a device coming in over Tailscale and nothing else", () => {
  expect(fromRemoteDevice(new Headers({ host: "pc.example.ts.net" }))).toBe(true);
  expect(fromRemoteDevice(new Headers({ host: "127.0.0.1:3000", "x-forwarded-host": "PC.example.ts.net:443" }))).toBe(true);
  for (const host of ["localhost:3000", "127.0.0.1:3000", "notts.net"]) expect(fromRemoteDevice(new Headers({ host }))).toBe(false);
  expect(fromRemoteDevice(new Headers())).toBe(false);
});

it("names the address the device used, so a phone's charts don't load from the phone itself", () => {
  const remote = new Request("https://localhost:3000/ai/artifacts/1/frame", { headers: { host: "pc.example.ts.net", "x-forwarded-host": "pc.example.ts.net", "x-forwarded-proto": "https" } });
  expect(requestOrigin(remote)).toBe("https://pc.example.ts.net");
  expect(requestOrigin(new Request("http://localhost:3000/ai/artifacts/1/frame", { headers: { host: "localhost:3000" } }))).toBe("http://localhost:3000");
});
