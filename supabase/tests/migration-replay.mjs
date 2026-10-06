export async function replayMigrations(tx, migrations, path) {
  for (const migration of migrations) {
    try { await tx.unsafe(migration.sql); }
    catch (cause) {
      throw new Error(`${path}: migration ${migration.file} failed (SQLSTATE ${cause.code ?? "unknown"}). Check schema against migration history; out-of-band SQL is not an applied migration. No verification writes are committed.`, { cause });
    }
  }
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
