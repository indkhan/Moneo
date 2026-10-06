export async function replayMigrations(tx, migrations, path) {
  for (const migration of migrations) {
    try { await tx.unsafe(migration.sql); }
    catch (cause) {
      throw new Error(`${path}: migration ${migration.file} failed (SQLSTATE ${cause.code ?? "unknown"}). Check schema against migration history; out-of-band SQL is not an applied migration. No verification writes are committed.`, { cause });
    }
  }
}
