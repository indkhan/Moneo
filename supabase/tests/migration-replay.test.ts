import { expect, it } from "vitest";
import { canonicalFunctionDefinition, replayMigrations } from "./migration-replay.mjs";

it("identifies a missing upgrade constraint without treating unrecorded SQL as applied", async () => {
  const cause = Object.assign(new Error("missing constraint"), { code: "42704" });
  const tx = { unsafe: async () => { throw cause; } };
  await expect(replayMigrations(tx, [{ file: "202610040001_reimport_undone_files.sql", sql: "alter table public.imports drop constraint imports_workspace_hash_unique" }], "upgrade"))
    .rejects.toThrow(/upgrade.*202610040001.*42704.*migration history/);
});

const definition = (body: string) => `CREATE OR REPLACE FUNCTION public.example()\n RETURNS text\n LANGUAGE plpgsql\n SECURITY DEFINER\nAS $function$${body}$function$\n`;

it("canonicalizes only code and comment CRLF, including mixed line endings", () => {
  const lf = definition("\nbegin\n-- unmatched ' quote\n/* nested /* quote ' */ comment */\nreturn 'value';\nend\n");
  expect(canonicalFunctionDefinition(lf.replace("begin\n", "begin\r\n").replace("quote\n", "quote\r\n")))
    .toBe(canonicalFunctionDefinition(lf));
  expect(canonicalFunctionDefinition(definition("\r\nbegin\r\nreturn 'value';\r\nend\r\n")))
    .toBe(definition("\nbegin\nreturn 'value';\nend\n"));
});

it.each([
  "'line\nvalue'", "'doubled '' quote\nvalue'", '"quoted\nidentifier"',
  "$literal$line\nvalue$literal$", "$$line\nvalue$$", "E'escaped\\' quote\nvalue'",
])("preserves newline data bytes in %s", quoted => {
  const lf = definition(`\nbegin\nreturn ${quoted};\nend\n`);
  const crlfData = definition(`\r\nbegin\r\nreturn ${quoted.replaceAll("\n", "\r\n")};\r\nend\r\n`);
  expect(canonicalFunctionDefinition(crlfData)).not.toBe(canonicalFunctionDefinition(lf));
  expect(canonicalFunctionDefinition(crlfData)).toContain(quoted.replaceAll("\n", "\r\n"));
});

it("keeps logic, signature, security and privilege differences significant", () => {
  const base = { arguments: "", definition: canonicalFunctionDefinition(definition("return 'value';")), privileges: ["authenticated:EXECUTE"] };
  expect({ ...base, definition: canonicalFunctionDefinition(definition("return 'different';")) }).not.toEqual(base);
  expect({ ...base, definition: canonicalFunctionDefinition(definition("return 'value';").replace("SECURITY DEFINER", "SECURITY INVOKER")) }).not.toEqual(base);
  expect({ ...base, arguments: "id uuid" }).not.toEqual(base);
  expect({ ...base, privileges: ["PUBLIC:EXECUTE"] }).not.toEqual(base);
});

it("leaves unsupported languages and ambiguous plain backslash quotes byte exact", () => {
  const unsupported = definition("\r\nreturn 'value';\r\n").replace("LANGUAGE plpgsql", "LANGUAGE plpython3u");
  const ambiguous = definition("\r\nreturn 'backslash\\' quote\r\ndata';\r\n");
  expect(canonicalFunctionDefinition(unsupported)).toBe(unsupported);
  expect(canonicalFunctionDefinition(ambiguous)).toBe(ambiguous);
});

it("handles SQL bodies and quoted comment markers without interpreting data as code", () => {
  const lf = definition("\nselect '-- /* quote '' marker\nvalue';\n").replace("LANGUAGE plpgsql", "LANGUAGE sql");
  const mixed = lf.replace("\nselect", "\r\nselect").replace(";\n", ";\r\n");
  expect(canonicalFunctionDefinition(mixed)).toBe(lf);
  expect(canonicalFunctionDefinition(mixed.replace("marker\nvalue", "marker\r\nvalue"))).not.toBe(lf);
});

it.each(["\u00e9", "\u4e2d\u6587", "tag_\u00e92"])("preserves Unicode dollar tag %s data while normalizing outer code", tag => {
  const quoted = `$${tag}$line\nvalue$${tag}$`;
  const lf = definition(`\nbegin\nreturn ${quoted};\nend\n`);
  const mixed = definition(`\r\nbegin\r\nreturn ${quoted};\r\nend\r\n`);
  expect(canonicalFunctionDefinition(mixed)).toBe(lf);
  expect(canonicalFunctionDefinition(mixed.replace("line\nvalue", "line\r\nvalue"))).not.toBe(lf);
  expect(canonicalFunctionDefinition(mixed.replace("line\nvalue", "line\r\nvalue"))).toContain("line\r\nvalue");
});
