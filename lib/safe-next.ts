/** A return path after sign-in. Only same-site paths: browsers read a backslash as a slash, so `/\evil.com` would leave the site. */
export function safeNextPath(next: string | null | undefined) {
  return next && /^\/(?![/\\])[^\\]*$/.test(next) ? next : "/";
}
