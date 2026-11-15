export function readableError(cause: unknown) {
  const message = cause instanceof Error || (typeof cause === "object" && cause && "message" in cause) ? String((cause as { message: unknown }).message) : String(cause);
  return /<(!doctype|html|head|body)\b/i.test(message) || /cloudflare/i.test(message) ? "The database did not answer. Nothing was saved; try again in a moment." : message.slice(0, 500);
}
