/**
 * Plain guidance for sign-in failures, so provider wording never reaches the page. Sign-up and password reset
 * failures stay generic about whether an email has an account.
 */
export function authErrorMessage(error: unknown): string {
  const { code, message = "" } = (error ?? {}) as { code?: string; message?: string };
  const text = `${code ?? ""} ${message}`.toLowerCase();
  if (/rate.?limit|too many|over_/.test(text)) return "Too many attempts. Wait a few minutes and try again.";
  if (/failed to fetch|network|load failed/.test(text)) return "We could not reach Moneo. Check your connection and try again.";
  if (/invalid.?(login|credentials)/.test(text)) return "That email and password do not match. Try again, or use Forgot password.";
  if (/not.?confirmed/.test(text)) return "Confirm your email first, using the link we sent you. Or use Email me a sign-in link for a new one.";
  if (/already.?(registered|exists)/.test(text)) return "We could not create this account. If it is yours, sign in or use Forgot password.";
  if (/same.?password/.test(text)) return "Choose a password different from your current one.";
  if (/weak.?password|password.*(short|characters|least)/.test(text)) return "That password is too weak. Use at least 8 characters that are hard to guess.";
  if (/session|jwt|expired/.test(text)) return "Your reset link has expired. Request a new one.";
  return "Something went wrong. Try again.";
}
