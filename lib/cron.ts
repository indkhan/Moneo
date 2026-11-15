import { timingSafeEqual } from "node:crypto";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? ""), expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function cronRoute(run: (request: Request) => Promise<Response>) {
  return async (request: Request) => authorized(request) ? run(request) : Response.json({ error: "Unauthorized" }, { status: 401 });
}
