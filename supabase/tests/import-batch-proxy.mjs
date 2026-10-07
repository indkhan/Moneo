// Candidate-only acceptance: new objects live in an exactly removed private
// schema, while the installed workflow uses real owned Supabase auth/storage
// and the deployed financial row/control RPCs. Never applies public DDL.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import postgres from "postgres";

process.loadEnvFile(".env");
const origin = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const connection = new URL(process.env.SUPABASE_DB_URL);
const project = new URL(origin).hostname.split(".")[0];
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`));
const db = postgres(connection.toString(), { ssl: "require", max: 4, connect_timeout: 10, onnotice: () => {}, connection: { application_name: "mne015-batch-proxy", lock_timeout: "10s", statement_timeout: "120s" } });
const journal = ".qa/mne015-proxy.json", fixture = ".qa/mne015-fixture.json", report = ".qa/mne015-proxy-counts.json";
const recoveryOnly = process.argv.includes("--cleanup");
const recovery = recoveryOnly ? JSON.parse(readFileSync(journal, "utf8")) : null;
const schema = recovery?.schema ?? `mne015_batch_qa_${randomBytes(8).toString("hex")}`;
assert(/^mne015_batch_qa_[a-f0-9]{16}$/.test(schema));
if (recovery) assert.equal(recovery.project, project);
const definitions = {
  read_import_stage: ["p_import_id", "p_workspace_id", "p_run_version"],
  stage_import_rows: ["p_import_id", "p_workspace_id", "p_run_version", "p_file_hash", "p_mapping", "p_routes", "p_source_id", "p_rows"],
  import_batch_candidates: ["p_import_id", "p_workspace_id", "p_run_version", "p_offset"],
  ingest_import_batch: ["p_import_id", "p_workspace_id", "p_run_version", "p_offset", "p_decisions"],
};
const privateNames = [...Object.keys(definitions), "import_staging", "prevent_import_staging_update"];
const history = await db`select version from supabase_migrations.schema_migrations order by version`;
const counts = { rpc: {}, sourceDownloads: 0, candidateBoundaryPauses: 0 };
mkdirSync(".qa", { recursive: true });
if (!recoveryOnly) {
  assert(!existsSync(journal), "Resolve the exact prior proxy journal before starting another fixture");
  writeFileSync(journal, JSON.stringify({ schema, project, fixture, port: 3053 }));
}
let server, closing = false, paused = false;
async function cleanup() {
  if (closing) return; closing = true;
  server?.closeAllConnections(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  await db.unsafe(`drop schema if exists ${schema} cascade`);
  assert.equal((await db`select 1 from pg_namespace where nspname=${schema}`).length, 0);
  assert.deepEqual(await db`select version from supabase_migrations.schema_migrations order by version`, history);
  writeFileSync(report, JSON.stringify({ schemaRemoved: true, migrationHistoryUnchanged: true, ...counts }, null, 2));
  unlinkSync(journal); await db.end();
  console.log("PASS: precisely owned candidate schema removed; public migration history unchanged");
}
try {
  if (recoveryOnly) { assert(!existsSync(fixture), "Clean the exact owned browser fixture first"); await cleanup(); process.exit(0); }
  await db.unsafe(`create schema ${schema}; grant usage on schema ${schema} to service_role`);
  let sql = readFileSync("supabase/migrations/202610070015_normalized_import_batches.sql", "utf8").split("-- Deployment indexes:")[0];
  for (const name of privateNames) sql = sql.replaceAll(`public.${name}`, `${schema}.${name}`);
  await db.unsafe(sql);
  server = createServer(async (req, res) => {
    try {
      const name = req.url?.split("?")[0].replace("/rest/v1/rpc/", "");
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !["host", "content-length", "accept-encoding", "connection"].includes(key)));
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 70_000_000) throw new Error("QA request bound exceeded"); chunks.push(chunk); }
      const body = Buffer.concat(chunks);
      if (definitions[name]) {
        assert.equal(req.method, "POST");
        assert.equal(req.headers.authorization, `Bearer ${serviceKey}`, "Candidate RPCs require the actual service boundary");
        const args = JSON.parse(body.toString("utf8"));
        const owned = JSON.parse(readFileSync(fixture, "utf8"));
        assert.equal(owned.qaTest, "import-control"); assert.equal(args.p_workspace_id, owned.workspace);
        const owners = await db`select w.id from public.workspaces w join auth.users u on u.id=w.owner_id where w.id=${owned.workspace} and w.owner_id=${owned.user} and u.raw_user_meta_data->>'qa_test'='import-control'`;
        assert.equal(owners.length, 1, "Only the journaled synthetic owner may use the candidate schema");
        // Inject one controlled interruption window between committed batches;
        // no financial responses/data are mocked, and later cancellation is
        // enforced by the real database run lock before any next batch effects.
        if (name === "import_batch_candidates" && args.p_offset === 250 && !paused) {
          paused = true; counts.candidateBoundaryPauses++;
          await new Promise(resolve => setTimeout(resolve, 6000));
        }
        counts.rpc[name] = (counts.rpc[name] ?? 0) + 1;
        const ordered = definitions[name]; assert.deepEqual(Object.keys(args).sort(), [...ordered].sort());
        const types = ordered.map(key => key.endsWith("_id") ? "uuid" : ["p_run_version", "p_offset"].includes(key) ? "integer" : ["p_rows", "p_decisions", "p_mapping", "p_routes"].includes(key) ? "jsonb" : "text");
        // postgres.js encodes native values for inferred JSONB parameters.
        // Passing a serialized string would turn the array into a JSON string.
        const values = ordered.map(key => args[key]);
        const data = await db.begin(async tx => {
          await tx.unsafe("set local role service_role");
          return tx.unsafe(`select ${schema}.${name}(${types.map((type, index) => `$${index + 1}::${type}`).join(",")}) as result`, values);
        });
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(data[0].result)); return;
      }
      if (req.url?.startsWith("/storage/v1/object/authenticated/imports/") && req.method === "GET") counts.sourceDownloads++;
      const response = await fetch(new URL(req.url, origin), { method: req.method, headers, ...(body.length ? { body } : {}), redirect: "manual" });
      const outputHeaders = Object.fromEntries([...response.headers].filter(([key]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)));
      res.writeHead(response.status, outputHeaders); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: error.code ?? "QA_PROXY_GUARD", message: error.code ? error.message : "Candidate fixture ownership/service guard rejected the request" }));
    }
  });
  await new Promise(resolve => server.listen(3053, "localhost", resolve));
  console.log("READY: owned candidate batch RPC proxy localhost3053; no public DDL");
  process.once("SIGINT", () => cleanup().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); }));
  process.once("SIGTERM", () => cleanup().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); }));
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", command => { if (command.trim() === "cleanup") cleanup().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); }); });
} catch (error) { await cleanup(); throw error; }
