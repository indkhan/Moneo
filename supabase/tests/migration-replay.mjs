export async function replayMigrations(tx, migrations, path) {
  for (const migration of migrations) {
    try { await tx.unsafe(migration.sql); }
    catch (cause) {
      throw new Error(`${path}: migration ${migration.file} failed (SQLSTATE ${cause.code ?? "unknown"}). Check schema against migration history; out-of-band SQL is not an applied migration. No verification writes are committed.`, { cause });
    }
  }
}

// Fixtures share one rollback-only transaction. A savepoint per fixture keeps
// their data, role and transaction-local settings from reaching the next one.
export async function runIsolatedFixture(tx, label, sql) {
  const done = new Error("Fixture rolled back");
  try { await tx.savepoint(async savepoint => { await savepoint.unsafe(sql); throw done; }); }
  catch (cause) { if (cause !== done) throw new Error(`${label}: ${cause.message}`, { cause }); }
}

// Historical pg_get_functiondef bodies retain checkout newlines. Only code
// whitespace is equivalent; quoted data and the generated header stay exact.
export function canonicalFunctionDefinition(definition) {
  const opening = /^[ \t]*AS (\$(?:[A-Za-z_\u0080-\uffff][A-Za-z_0-9\u0080-\uffff]*)?\$)/m.exec(definition);
  if (!opening || !/\bLANGUAGE (?:sql|plpgsql)\b/.test(definition.slice(0, opening.index))) return definition;
  const start = opening.index + opening[0].length;
  const end = definition.lastIndexOf(opening[1]);
  if (end < start) return definition;
  const body = definition.slice(start, end);
  let normalized = "";
  for (let index = 0; index < body.length;) {
    const from = index, quote = body[index];
    if (quote === "'" || quote === '"') {
      const escaped = quote === "'" && /[eE]/.test(body[index - 1] ?? "") && !/[\w$\u0080-\uffff]/.test(body[index - 2] ?? "");
      index++;
      while (index < body.length) {
        // Unknown standard_conforming_strings: fail closed on ambiguous quotes.
        if (!escaped && quote === "'" && body[index] === "\\" && body[index + 1] === "'") return definition;
        if (escaped && body[index] === "\\") { index += 2; continue; }
        if (body[index++] === quote) { if (body[index] !== quote) break; index++; }
      }
      normalized += body.slice(from, index);
    } else if (body.startsWith("--", index)) {
      const newline = body.indexOf("\n", index);
      index = newline < 0 ? body.length : newline + 1;
      normalized += body.slice(from, index).replaceAll("\r\n", "\n");
    } else if (body.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < body.length && depth) {
        if (body.startsWith("/*", index)) { depth++; index += 2; }
        else if (body.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      normalized += body.slice(from, index).replaceAll("\r\n", "\n");
    } else {
      const delimiter = !/[\w$\u0080-\uffff]/.test(body[index - 1] ?? "") && /^(\$(?:[A-Za-z_\u0080-\uffff][A-Za-z_0-9\u0080-\uffff]*)?\$)/.exec(body.slice(index));
      if (delimiter) {
        const closing = body.indexOf(delimiter[1], index + delimiter[1].length);
        if (closing < 0) return definition;
        index = closing + delimiter[1].length;
        normalized += body.slice(from, index);
      } else if (body.startsWith("\r\n", index)) { normalized += "\n"; index += 2; }
      else normalized += body[index++];
    }
  }
  return definition.slice(0, start) + normalized + definition.slice(end);
}
// Disposable application replays must not change Supabase-owned storage setup.
/** @param {string} file @param {string} sql @param {string} [schema] */
export function applicationMigrationSql(file, sql, schema) {
  if (schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Invalid disposable schema name");
    sql = sql.replace(/\bn\.nspname(\s*=\s*)'public'/g, `n.nspname$1'${schema}'`);
  }
  if (file.endsWith("_initial.sql")) {
    const boundary = sql.indexOf("insert into storage.buckets");
    if (boundary < 0) throw new Error("Initial storage boundary changed; review disposable replay isolation");
    return sql.slice(0, boundary);
  }
  if (file === "202610270003_chat_attachments.sql") {
    const boundary = sql.indexOf("alter table public.messages");
    if (boundary < 0) throw new Error("Chat storage boundary changed; review disposable replay isolation");
    return sql.slice(boundary);
  }
  if (file === "202610200003_remove_artifacts_and_library.sql") {
    const start = sql.indexOf("drop policy private_finance_files on storage.objects;");
    const end = sql.indexOf("create or replace function public.reset_workspace()", start);
    if (start < 0 || end < 0) throw new Error("Storage policy boundary changed; review disposable replay isolation");
    return sql.slice(0, start) + sql.slice(end);
  }
  return sql;
}
