import { createHmac, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { expect, it } from "vitest";
import type { Database } from "@/lib/database";
import { serviceClient } from "@/lib/service-db";
import { LOG_AUDIO_BUCKET } from "./options";
import { deleteAllLogs, deleteExpiredLogs } from "./store";

const enabled = process.env.RUN_LOGS_DB_TESTS === "1";

function ownerClient(user: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user, role: "authenticated", aud: "authenticated", iat: now, exp: now + 300 })}`;
  const token = `${unsigned}.${createHmac("sha256", process.env.JWT_SECRET!).update(unsigned).digest("base64url")}`;
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
}

it.skipIf(!enabled)("deletes logs and their audio older than the owner's retention, only for the owner, and lets the owner delete the rest", { timeout: 30_000 }, async () => {
  process.loadEnvFile(".env.qa");
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const service = serviceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const owner = randomUUID(), stranger = randomUUID();
  try {
    for (const user of [owner, stranger]) await db`insert into auth.users(id,email) values(${user},${`qa-${user}@example.invalid`})`;
    const [{ id: workspace }] = await db<{ id: string }[]>`select id from public.workspaces where owner_id=${owner}`;
    await db`insert into public.workspace_settings(workspace_id,timezone,log_retention) values(${workspace},'Europe/Berlin','7')
      on conflict(workspace_id) do update set timezone=excluded.timezone, log_retention=excluded.log_retention`;
    const now = new Date("2026-11-27T12:00:00Z");
    const oldId = randomUUID(), keptId = randomUUID(), edgeId = randomUUID();
    const oldAudio = `${workspace}/${oldId}.wav`;
    expect((await service.storage.from(LOG_AUDIO_BUCKET).upload(oldAudio, new Uint8Array([82, 73, 70, 70]), { contentType: "audio/wav" })).error).toBeNull();
    await db`insert into public.app_logs(id,workspace_id,created_at,level,area,event,message,audio_path) values
      (${oldId},${workspace},'2026-11-19T22:59:59Z','info','voice','speech_to_text','old',${oldAudio}),
      (${edgeId},${workspace},'2026-11-19T23:00:00Z','info','ai','ai.chat','first kept',null),
      (${keptId},${workspace},'2026-11-26T08:00:00Z','error','sync','bank.sync_finish','recent',null)`;

    await deleteExpiredLogs(service, now);

    const left = await db<{ id: string }[]>`select id from public.app_logs where workspace_id=${workspace} order by created_at`;
    expect(left.map(row => row.id)).toEqual([edgeId, keptId]);
    expect((await service.storage.from(LOG_AUDIO_BUCKET).download(oldAudio)).error).not.toBeNull();

    expect((await ownerClient(stranger).from("app_logs").select("id").eq("workspace_id", workspace)).data).toEqual([]);
    expect((await ownerClient(owner).from("app_logs").select("id").eq("workspace_id", workspace)).data).toHaveLength(2);
    expect((await ownerClient(owner).from("app_logs").insert({ workspace_id: workspace, level: "info", area: "ai", event: "x", message: "forged" })).error).not.toBeNull();

    const keptAudio = `${workspace}/${keptId}.wav`;
    await service.storage.from(LOG_AUDIO_BUCKET).upload(keptAudio, new Uint8Array([1]), { contentType: "audio/wav" });
    await db`update public.app_logs set audio_path=${keptAudio} where id=${keptId}`;
    await deleteAllLogs(ownerClient(owner), workspace);
    expect(await db`select id from public.app_logs where workspace_id=${workspace}`).toHaveLength(0);
    expect((await service.storage.from(LOG_AUDIO_BUCKET).list(workspace)).data).toEqual([]);
  } finally {
    const workspaces = await db<{ id: string }[]>`select id from public.workspaces where owner_id in (${owner}, ${stranger})`;
    for (const { id } of workspaces) {
      const listed = await service.storage.from(LOG_AUDIO_BUCKET).list(id);
      if (listed.data?.length) await service.storage.from(LOG_AUDIO_BUCKET).remove(listed.data.map(file => `${id}/${file.name}`));
      for (const table of ["app_logs", "categories", "workspace_settings"]) await db.unsafe(`delete from public.${table} where workspace_id = $1`, [id]);
    }
    await db`delete from public.workspaces where owner_id in (${owner}, ${stranger})`;
    await db`delete from auth.users where id in (${owner}, ${stranger})`;
    await db.end();
  }
});
