import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { EnableBankingError, enableBankingClient, enableBankingConfigured } from "@/lib/bank/enable-banking";
import { consentValidUntil, enableBankingErrorMessage, psuFrom } from "@/lib/bank/server";
import { serviceDb } from "@/lib/service-db";
import { BANK_REDIRECT_URL } from "@/lib/bank/return-listener";
import { connectOnComputer, fromRemoteDevice } from "@/lib/remote-device";
import { hasServiceRoleKey } from "@/lib/env";
import { jsonBodyOrNull } from "@/lib/json-body";

const bodySchema = z.object({ aspspName: z.string().trim().min(1).max(200), country: z.string().regex(/^[A-Z]{2}$/) }).strict();

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  if (fromRemoteDevice(request.headers)) return NextResponse.json({ error: connectOnComputer("The bank login") }, { status: 409 });
  if (!(await enableBankingConfigured()) || !hasServiceRoleKey()) return NextResponse.json({ error: "Bank sync is not configured" }, { status: 503 });
  const body = bodySchema.safeParse(await jsonBodyOrNull(request));
  if (!body.success) return NextResponse.json({ error: "Choose a bank" }, { status: 400 });
  try {
    const client = await enableBankingClient();
    const aspsp = (await client.listAspsps(body.data.country)).find(bank => bank.name === body.data.aspspName);
    if (!aspsp) return NextResponse.json({ error: "That bank is not available" }, { status: 400 });
    const pending = await serviceDb().from("bank_connections").insert({ workspace_id: context.workspace.id, aspsp_name: aspsp.name, aspsp_country: aspsp.country })
      .select("auth_state").single();
    if (pending.error) throw pending.error;
    const { url } = await client.startAuthorization({
      aspsp: { name: aspsp.name, country: aspsp.country }, validUntil: consentValidUntil(aspsp.maximum_consent_validity),
      state: pending.data.auth_state, redirectUrl: BANK_REDIRECT_URL, psu: psuFrom(request),
    });
    return NextResponse.json({ url });
  } catch (error) {
    console.error("bank connect failed", error instanceof EnableBankingError ? error.message : error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: enableBankingErrorMessage(error, "The bank connection could not be started") }, { status: 502 });
  }
}
