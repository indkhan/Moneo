import path from "node:path";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const realWait = [
  {
    selector: "NewExpression[callee.name='Promise'] CallExpression[callee.name='setTimeout'][arguments.1.type='Literal']",
    message: "Real waits make tests slow and flaky. Use fake timers, a controlled promise, or await the real event (AGENTS.md Tests).",
  },
  {
    selector: "CallExpression[callee.property.name='waitForTimeout']",
    message: "Real waits make tests slow and flaky. Await the real event or condition instead of page.waitForTimeout (AGENTS.md Tests).",
  },
];

const dynamicSkip = {
  selector:
    "CallExpression:matches([callee.name='test'], [callee.name='it'], [callee.object.name='test'][callee.property.name=/^(only|fixme|beforeEach|afterEach|beforeAll|afterAll)$/]) CallExpression[callee.object.name='test'][callee.property.name='skip']",
  message: "Don't skip from inside a test. Arrange the state the test needs instead; only a file-level test.skip(condition, reason) is allowed (AGENTS.md Tests).",
};

const migrationText = {
  selector:
    "CallExpression[callee.name='readFileSync'] :matches(Literal[value=/supabase\\/migrations/], TemplateElement[value.raw=/supabase\\/migrations/])",
  message: "Test behaviour, not migration text. Don't read supabase/migrations in unit tests (AGENTS.md Tests).",
};

const ownerApp = {
  selector: ":matches(Literal[value=/(localhost|127\.0\.0\.1):3000/], TemplateElement[value.raw=/(localhost|127\.0\.0\.1):3000/])",
  message: "Port 3000 is the owner's app. Use the base URL from playwright.config.ts (the QA server on 3100) (AGENTS.md Test backend).",
};

const migrationReaders = [
  "lib/schema.test.ts",
  "lib/finance/currency-precision-contract.test.ts",
  "supabase/tests/**",
  "**/*.live.test.ts",
];

const directiveReason = String.raw`(\s+--?\s.{1,120})?\s*$`;
const toolDirectives = [
  new RegExp(String.raw`^\s*eslint-(disable|enable)(-next-line|-line)?\s+[\w@/-]+(\s*,\s*[\w@/-]+)*` + directiveReason),
  new RegExp(String.raw`^\s*@ts-expect-error` + directiveReason),
  /^\s*(turbopack|webpack)Ignore:\s*true\s*$/,
  /^\s*@vitest-environment\s+[\w-]+\s*$/,
  /^\*\s*@type\s*\{[^}]*\}\s*$/,
  /^\/\s*<reference\s[^>]*\/>\s*$/,
];

const noComments = {
  meta: {
    type: "suggestion",
    fixable: "code",
    schema: [],
    messages: {
      banned: "Comments are banned: they go stale and nothing checks them. Delete it and put the meaning in a name, a type, a test or a lint rule. If it defends a workaround, fix the cause instead (AGENTS.md How to work).",
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      Program() {
        for (const comment of source.getAllComments()) {
          if (comment.type === "Shebang" || toolDirectives.some(directive => directive.test(comment.value))) continue;
          context.report({
            loc: comment.loc,
            messageId: "banned",
            fix(fixer) {
              const text = source.text;
              let [start, end] = comment.range;
              const holder = source.getNodeByRangeIndex(start);
              if (holder?.type === "JSXEmptyExpression" && source.getCommentsInside(holder.parent).length === 1) [start, end] = holder.parent.range;
              let lineStart = start;
              while (lineStart > 0 && (text[lineStart - 1] === " " || text[lineStart - 1] === "\t")) lineStart--;
              let lineEnd = end;
              while (lineEnd < text.length && (text[lineEnd] === " " || text[lineEnd] === "\t")) lineEnd++;
              const opensLine = lineStart === 0 || text[lineStart - 1] === "\n";
              const closesLine = lineEnd === text.length || text[lineEnd] === "\n" || text[lineEnd] === "\r";
              if (opensLine && closesLine) {
                if (text[lineEnd] === "\r") lineEnd++;
                if (text[lineEnd] === "\n") lineEnd++;
                return fixer.removeRange([lineStart, lineEnd]);
              }
              if (closesLine) return fixer.removeRange([lineStart, end]);
              if (opensLine || lineStart < start) return fixer.removeRange([start, lineEnd]);
              if (lineEnd > end) return fixer.removeRange([start, end]);
              return fixer.replaceTextRange([start, end], " ");
            },
          });
        }
      },
    };
  },
};

const isTest = file => /\.(test|spec)\.tsx?$/.test(file);
const under = (file, folder) => file === folder || file.startsWith(`${folder}/`);

const layers = [
  {
    applies: file => !under(file, "desktop") && !under(file, "scripts/desktop"),
    bans: target => ["electron", "electron-updater"].includes(target.split("/")[0]) || under(target, "desktop"),
    message: "The Next.js server also runs without Electron. Keep Electron code in desktop/src and reach it through lib/desktop-bridge.ts (AGENTS.md Desktop app).",
  },
  {
    applies: file => under(file, "desktop/src"),
    bans: (target, local) => local && !under(target, "desktop"),
    message: "The Electron main process is built apart from the Next.js server. Talk to the server over its loopback address instead of importing its code (AGENTS.md Desktop app).",
  },
  {
    applies: file => (under(file, "lib") || under(file, "workflows")) && !isTest(file),
    bans: (target, local) => local && (under(target, "app") || under(target, "components")),
    message: "lib/ and workflows/ sit below app/ and components/. Move the shared code into lib/ and import it from there (AGENTS.md Project map).",
  },
  {
    applies: file => under(file, "components") && !isTest(file),
    bans: (target, local) => local && under(target, "app"),
    message: "components/ sits below app/. Move the shared component to components/, or the shared logic or server action to lib/ (AGENTS.md Project map).",
  },
  {
    applies: file => under(file, "lib/finance") && !isTest(file),
    bans: (target, local) => local && under(target, "lib/ai"),
    message: "Financial truth comes from code and data, never from AI. lib/finance must not import lib/ai; pass plain data in instead (AGENTS.md Non-negotiables).",
  },
];

const importBoundaries = {
  meta: { type: "problem", schema: [], messages: { crossed: "'{{source}}' crosses a boundary. {{why}}" } },
  create(context) {
    const file = path.relative(context.cwd, context.filename).replaceAll("\\", "/");
    const active = layers.filter(layer => layer.applies(file));
    const check = source => {
      if (typeof source?.value !== "string") return;
      const local = /^(@\/|\.)/.test(source.value);
      const target = source.value.startsWith("@/") ? source.value.slice(2)
        : local ? path.posix.normalize(path.posix.join(path.posix.dirname(file), source.value))
        : source.value;
      for (const layer of active) if (layer.bans(target, local)) context.report({ node: source, messageId: "crossed", data: { source: source.value, why: layer.message } });
    };
    return {
      ImportDeclaration: node => check(node.source),
      ExportNamedDeclaration: node => check(node.source),
      ExportAllDeclaration: node => check(node.source),
      ImportExpression: node => check(node.source),
      "CallExpression[callee.name='require']": node => check(node.arguments[0]),
      "CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock|importActual)$/]": node => check(node.arguments[0]),
    };
  },
};

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    plugins: { moneo: { rules: { "no-comments": noComments, "import-boundaries": importBoundaries } } },
    rules: { "moneo/no-comments": "error", "moneo/import-boundaries": "error" },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "e2e/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...realWait, dynamicSkip] },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    ignores: migrationReaders,
    rules: { "no-restricted-syntax": ["error", ...realWait, dynamicSkip, migrationText] },
  },
  {
    files: ["e2e/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...realWait, dynamicSkip, ownerApp] },
  },
  globalIgnores([".next/**", ".next-qa/**", "out/**", "build/**", "next-env.d.ts", "app/.well-known/workflow/**", ".qa/**", ".claude/**", "promo/**", ".next-desktop/**", "desktop/.build/**", "desktop/.cache/**", "desktop/dist/**", "desktop/release/**", "desktop/release-preview/**"]),
]);
