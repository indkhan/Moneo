// Explicit ordered deployment only, after rollback verifier passes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";

process.loadEnvFile(".env");
const versions = process.argv.slice(2);
assert(versions.length && versions.every(version => /^\d{12}$/.test(version)), "Pass exact ordered migration versions");
assert.deepEqual(versions, [...new Set(versions)].sort(), "Versions must be unique and ordered");
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const connection = new URL(process.env.SUPABASE_DB_URL);
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`), "Configured database must match Supabase project");
const files = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort();
const selected = versions.map(version => {
  const matches = files.filter(file => file.startsWith(`${version}_`));
  assert.equal(matches.length, 1, "Each version must identify one migration");
  const file = matches[0];
  const source = readFileSync(`supabase/migrations/${file}`, "utf8");
  return { version, file, name: file.slice(version.length + 1, -4), source, hash: createHash("sha256").update(source).digest("hex") };
});
const db = postgres(connection.toString(), { ssl: "require", max: 1, connect_timeout: 10, onnotice: () => {} });
try {
  await db.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtext('moneo:migrations'))`;
    const history = await tx`select version,name,statements from supabase_migrations.schema_migrations order by version`;
    const earlier = files.filter(file => file.split("_")[0] < versions.at(-1) && !versions.includes(file.split("_")[0]));
    assert(earlier.every(file => history.some(row => row.version === file.split("_")[0])), "Do not skip earlier pending migrations");
    for (const migration of selected) {
      const applied = history.find(row => row.version === migration.version);
      if (applied) {
        assert.equal(applied.name, migration.name, "Applied migration name differs");
        assert.equal(createHash("sha256").update(applied.statements.join("\n")).digest("hex"), migration.hash, "Applied migration content differs");
        continue;
      }
      await tx.unsafe(migration.source);
      await tx`insert into supabase_migrations.schema_migrations(version,name,statements) values(${migration.version},${migration.name},${tx.array([migration.source])})`;
    }
  });
  for (const migration of selected) {
    const [row] = await db`select name,statements from supabase_migrations.schema_migrations where version=${migration.version}`;
    assert.equal(row.name, migration.name);
    assert.equal(createHash("sha256").update(row.statements.join("\n")).digest("hex"), migration.hash);
    console.log(`${migration.version} ${migration.name} sha256=${migration.hash}`);
  }
} finally { await db.end(); }
