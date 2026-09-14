import { Client } from "pg";
import { loadEnv } from "@moneo/shared/env";
import { createAiStore, closeDb, uuidv7 } from "../src/index.js";
import { runChat } from "../../../apps/web/src/lib/ai-chat.js";
import { encryptCredential } from "../../../apps/web/src/lib/ai-credentials.js";
const env = loadEnv(),
  owner = new Client({ connectionString: env.DATABASE_MIGRATION_URL });
await owner.connect();
const wid = uuidv7(),
  accountId = uuidv7(),
  transactionId = uuidv7(),
  categoryId = uuidv7();
try {
  await owner.query("INSERT INTO workspaces(id,name) VALUES($1,'Moneo synthetic AI smoke')", [wid]);
  await owner.query(
    "INSERT INTO accounts(id,workspace_id,name,currency_code) VALUES($1,$2,'Synthetic EUR checking','EUR')",
    [accountId, wid],
  );
  await owner.query("INSERT INTO categories(id,workspace_id,name) VALUES($1,$2,'Restaurants')", [
    categoryId,
    wid,
  ]);
  await owner.query(
    "INSERT INTO transactions(id,workspace_id,account_id,direction,amount_minor,currency_code,effective_date,description,category_id) VALUES($1,$2,$3,'debit',1234,'EUR','2026-08-03','Synthetic restaurant',$4)",
    [transactionId, wid, accountId, categoryId],
  );
  const events: Array<Record<string, unknown>> = [];
  const mode = process.env.MONEO_AI_SMOKE_MODE === "custom" ? "custom" : "included";
  if (mode === "custom") {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("Synthetic custom smoke needs the configured OpenRouter key");
    await createAiStore().updateSettings(wid, {
      mode: "custom",
      credentialCiphertext: await encryptCredential(key, wid, {
        environment: env.APP_ENV,
        wrappingKey: env.AI_CREDENTIAL_ENCRYPTION_KEY,
        kmsKeyId: env.AI_CREDENTIAL_KMS_KEY_ID,
      }),
    });
  }
  await runChat({
    workspaceId: wid,
    input: { message: "How much did I spend on Restaurants in August 2026 in EUR? Cite evidence." },
    signal: AbortSignal.timeout(85000),
    emit: (event) => {
      events.push(event);
      if (event.type !== "text") console.log(JSON.stringify(event));
    },
  });
  const text = events
    .filter((e) => e.type === "text")
    .map((e) => e.text)
    .join("");
  const completed = events.some((e) => e.type === "done");
  console.log(JSON.stringify({ completed, answer: text }));
  if (!completed || !text.includes("12.34"))
    throw new Error("Synthetic expected amount 12.34 EUR missing");
  const event = events.find((e) => e.type === "evidence")?.evidence as { id: string } | undefined;
  if (!event) throw new Error("Evidence missing");
  const stored = await createAiStore().evidence(wid, event.id);
  if (!JSON.stringify(stored).includes("1234")) throw new Error("Exact evidence amount missing");
  console.log(`PASS (${mode}): live model answer, durable evidence and exact synthetic amount`);
} finally {
  await closeDb();
  await owner.query("DELETE FROM workspaces WHERE id=$1", [wid]);
  await owner.end();
}
