import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LoginPage from "./page";

const host = vi.hoisted(() => ({ index: 0, slots: [] as unknown[], createClient: vi.fn(), signInWithOtp: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: host.createClient }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = host.index++;
    if (!(index in host.slots)) host.slots[index] = initial;
    return [host.slots[index], (next: unknown) => { host.slots[index] = typeof next === "function" ? next(host.slots[index]) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = host.index++;
    if (!(index in host.slots)) host.slots[index] = { current: initial };
    return host.slots[index];
  },
}));
beforeEach(() => {
  host.index = 0; host.slots = []; vi.clearAllMocks();
  host.createClient.mockReturnValue({ auth: { signInWithOtp: host.signInWithOtp } });
  vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
});
afterEach(() => vi.unstubAllGlobals());
function formSubmit(node: ReactNode): ((event: { preventDefault: () => void }) => Promise<void>) | undefined {
  if (Array.isArray(node)) return node.map(formSubmit).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; onSubmit?: (event: { preventDefault: () => void }) => Promise<void> }>(node)) return;
  return node.type === "form" ? node.props.onSubmit : formSubmit(node.props.children);
}
function render() { host.index = 0; return LoginPage(); }
const event = { preventDefault: vi.fn() };

it("reports client configuration failures and permits a retry", async () => {
  host.createClient.mockImplementationOnce(() => { throw new Error("Supabase configuration is missing"); });
  await expect(formSubmit(render())!(event)).resolves.toBeUndefined();
  expect(renderToStaticMarkup(render())).toContain("Supabase configuration is missing");
  host.signInWithOtp.mockResolvedValue({ error: null });
  await formSubmit(render())!(event);
  expect(renderToStaticMarkup(render())).toContain("Check your email for the sign-in link.");
});

it("sends one sign-in request while pending and unlocks the form after failure", async () => {
  let settle!: (result: { error: { message: string } }) => void;
  host.signInWithOtp.mockReturnValue(new Promise(resolve => { settle = resolve; }));
  const submit = formSubmit(render())!;
  const pending = submit(event);
  const duplicate = submit(event);
  expect(host.signInWithOtp).toHaveBeenCalledOnce();
  expect(renderToStaticMarkup(render())).toMatch(/disabled=""[^>]*>Sending/);
  settle({ error: { message: "Try again later" } });
  await Promise.all([pending, duplicate]);
  const html = renderToStaticMarkup(render());
  expect(html).toContain("Try again later");
  expect(html).not.toContain('disabled=""');
});
