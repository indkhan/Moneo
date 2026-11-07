import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { checkEnableBankingCredentials, EnableBankingError } from "@/lib/bank/enable-banking";
import { enableBankingErrorMessage } from "@/lib/bank/server";
import { removeServiceKeys, saveServiceKeys } from "@/lib/service-keys";

const bodySchema = z.object({
  appId: z.string().trim().min(1, "Enter the App ID").max(200),
  privateKey: z.string().trim().max(10_000, "That private key is too long").refine(value => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value), "Paste the private key file, starting with -----BEGIN PRIVATE KEY-----"),
}).strict();

// The owner's Enable Banking application, checked with Enable Banking before it is saved.
export async function POST(request: Request) {
  try { await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!process.env.BANK_TOKEN_ENCRYPTION_KEY) return NextResponse.json({ error: "Moneo isn't set up yet. Run npm run setup, then restart Moneo." }, { status: 503 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: body.error.issues[0].message }, { status: 400 });
  const { appId, privateKey } = body.data;
  try { await checkEnableBankingCredentials({ appId, privateKey }); } catch (error) {
    console.error("bank credentials check failed", error instanceof Error ? error.message : "unknown error");
    const message = !(error instanceof EnableBankingError) ? "Couldn't reach Enable Banking to check the App ID and key. Try again."
      : error.code === "INVALID_PRIVATE_KEY" ? "That private key could not be read. Paste the whole .pem file or upload it."
      : error.status === 401 || error.status === 403 ? "Enable Banking rejected the App ID or private key. Check that the key belongs to this App ID."
      : enableBankingErrorMessage(error, "Enable Banking couldn't check the App ID and key");
    return NextResponse.json({ error: message }, { status: 400 });
  }
  try { await saveServiceKeys({ enable_banking_app_id: appId, enable_banking_private_key: privateKey }); }
  catch { return NextResponse.json({ error: "The App ID and key could not be saved" }, { status: 500 }); }
  return NextResponse.json({ saved: true });
}

// Connected banks and imported transactions stay; syncing stops until new credentials are saved.
export async function DELETE() {
  try { await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  try { await removeServiceKeys(["enable_banking_app_id", "enable_banking_private_key"]); }
  catch { return NextResponse.json({ error: "The App ID and key could not be removed" }, { status: 500 }); }
  return NextResponse.json({ removed: true });
}
