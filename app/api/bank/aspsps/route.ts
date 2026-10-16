import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { enableBankingClient, enableBankingConfigured } from "@/lib/bank/enable-banking";

// Bank picker list for one country, cached in the browser for a day.
export async function GET(request: Request) {
  try { await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!enableBankingConfigured()) return NextResponse.json({ error: "Bank sync is not configured" }, { status: 503 });
  const country = z.string().regex(/^[A-Z]{2}$/).safeParse(new URL(request.url).searchParams.get("country"));
  if (!country.success) return NextResponse.json({ error: "Choose a two-letter country code" }, { status: 400 });
  try {
    const banks = await enableBankingClient().listAspsps(country.data);
    return NextResponse.json({ banks: banks.map(({ name, country, logo }) => ({ name, country, logo: logo ?? null })) },
      { headers: { "cache-control": "private, max-age=86400" } });
  } catch {
    return NextResponse.json({ error: "Banks could not be loaded" }, { status: 502 });
  }
}
