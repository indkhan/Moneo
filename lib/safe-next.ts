export function safeNextPath(next: string | null | undefined) {
  return next && /^\/(?![/\\])[^\\]*$/.test(next) ? next : "/";
}
