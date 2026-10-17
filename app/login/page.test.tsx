import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LoginPage from "./page";

const host = vi.hoisted(() => ({ index: 0, slots: [] as unknown[], createClient: vi.fn(), signInWithOtp: vi.fn(), signInWithPassword: vi.fn(), signUp: vi.fn(), resetPasswordForEmail: vi.fn() }));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
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
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
beforeEach(() => {
  host.index = 0; host.slots = ["magic-link"]; vi.clearAllMocks();
  const { signInWithOtp, signInWithPassword, signUp, resetPasswordForEmail } = host;
  host.createClient.mockReturnValue({ auth: { signInWithOtp, signInWithPassword, signUp, resetPasswordForEmail } });
  vi.stubGlobal("window", { location: { origin: "http://localhost:3000"} });
});
afterEach(() => vi.unstubAllGlobals());
function formSubmit(node: ReactNode): ((event: { preventDefault: () => void }) => Promise<void>) | undefined {
  if (Array.isArray(node)) return node.map(formSubmit).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; onSubmit?: (event: { preventDefault: () => void }) => Promise<void> }>(node)) return;
  return node.type === "form" ? node.props.onSubmit : formSubmit(node.props.children);
}
function render() { host.index = 0; return LoginPage(); }
const event = { preventDefault: vi.fn() };

it("returns deployed sign-in emails to the current website instead of localhost", async () => {
  vi.stubGlobal("window", { location: { origin: "https://moneo.example.com" } });
  host.signInWithOtp.mockResolvedValue({ error: null });
  await formSubmit(render())!(event);
  expect(host.signInWithOtp).toHaveBeenCalledWith({
    email: "",
    options: { emailRedirectTo: "https://moneo.example.com/auth/callback" },
  });
});

it("explains a failed callback and clears that message when retrying", async () => {
  vi.stubGlobal("window", { location: { origin: "http://localhost:3000", search: "?error=sign-in" } });
  render();
  expect(renderToStaticMarkup(render())).toContain("The sign-in link could not be verified. Request a new link and try again.");
  host.signInWithOtp.mockResolvedValue({ error: null });
  await formSubmit(render())!(event);
  expect(renderToStaticMarkup(render())).toContain("Check your email for the sign-in link.");
  expect(renderToStaticMarkup(render())).not.toContain("could not be verified");
});

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
  expect(renderToStaticMarkup(render())).toMatch(/disabled=""[^>]*>Working/);
  settle({ error: { message: "Try again later" } });
  await Promise.all([pending, duplicate]);
  const html = renderToStaticMarkup(render());
  expect(html).toContain("Try again later");
  expect(html).not.toContain('disabled=""');
});

it("signs in with email and password without any email round-trip", async () => {
  host.slots = ["sign-in", "a@b.co", "secret123"];
  host.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
  await formSubmit(render())!(event);
  expect(host.signInWithPassword).toHaveBeenCalledWith({ email: "a@b.co", password: "secret123" });
  expect(router.replace).toHaveBeenCalledWith("/");
});

it("signs up and enters the app immediately when a session is returned", async () => {
  host.slots = ["sign-up", "a@b.co", "secret123"];
  host.signUp.mockResolvedValue({ data: { session: {} }, error: null });
  await formSubmit(render())!(event);
  expect(host.signUp).toHaveBeenCalledWith({ email: "a@b.co", password: "secret123", options: { emailRedirectTo: "http://localhost:3000/auth/callback" } });
  expect(router.replace).toHaveBeenCalledWith("/");
});

it("sends password reset links back through the callback to the reset page", async () => {
  host.slots = ["forgot", "a@b.co"];
  host.resetPasswordForEmail.mockResolvedValue({ error: null });
  await formSubmit(render())!(event);
  expect(host.resetPasswordForEmail).toHaveBeenCalledWith("a@b.co", { redirectTo: "http://localhost:3000/auth/callback?next=/reset-password" });
  expect(renderToStaticMarkup(render())).toContain("Check your email for the password reset link.");
});
