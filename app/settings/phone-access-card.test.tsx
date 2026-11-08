import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PhoneAccessCard } from "./phone-access-card";

vi.mock("./phone-access-actions", () => ({ turnOn: vi.fn(), turnOff: vi.fn() }));

it("stays one line and a button until the owner asks for it", () => {
  const html = renderToStaticMarkup(<PhoneAccessCard initial={{ state: "off" }} />);
  expect(html).toContain("Turn on");
  expect(html).not.toContain("<a ");
  expect(html).not.toContain("<img");
});

it("shows only the step that is missing", () => {
  const html = renderToStaticMarkup(<PhoneAccessCard initial={{ state: "needs_approval", link: "https://login.tailscale.com/f/serve?node=abc" }} />);
  expect(html).toContain("https://login.tailscale.com/f/serve?node=abc");
  expect(html).toContain("Check again");
  expect(html).not.toContain("<img");
});

it("shows the address and scan code once on", () => {
  const html = renderToStaticMarkup(<PhoneAccessCard initial={{ state: "on", url: "https://pc.example.ts.net", qr: "<svg></svg>" }} />);
  expect(html).toContain("Scan code for https://pc.example.ts.net");
  expect(html).toContain('href="https://pc.example.ts.net"');
  expect(html).toContain("Turn off");
});
