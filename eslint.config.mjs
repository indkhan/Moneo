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

const hardCodedAddress = [
  {
    selector: ":matches(Literal[value=/(localhost|127\.0\.0\.1):3000/], TemplateElement[value.raw=/(localhost|127\.0\.0\.1):3000/])",
    message: "The desktop app and the QA app do not run on port 3000. Use appUrl(), loopbackUrl() or appPort() from lib/env.ts (AGENTS.md Desktop app).",
  },
  {
    selector: ":matches(LogicalExpression[operator='??'], LogicalExpression[operator='||'])[right.value=3000]",
    message: "The desktop app and the QA app do not run on port 3000. Use appPort() from lib/env.ts (AGENTS.md Desktop app).",
  },
];

const unexplainedIgnoredFailure = {
  selector: ":matches(CatchClause > BlockStatement[body.length=0], CallExpression[callee.property.name='catch'] > :matches(ArrowFunctionExpression, FunctionExpression) > BlockStatement[body.length=0])",
  message: "A workflow that ignores a failure must say what handles it instead. Call a function named for that reason, as workflows/bank-sync.ts does (catch { hourlyBacklogCheckPicksUpTheRows(); }), or record the failure (AGENTS.md How to work, \"Fix the class\").",
};

const assumedTimeZone = {
  selector: ":matches(Literal[value='Europe/Berlin'], TemplateElement[value.raw=/Europe.Berlin/])",
  message: "Never assume where the owner lives. Take the time zone from workspace.timezone or settings.timezone (set in Settings, detected from their device) and pass it in (AGENTS.md Rules).",
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
    applies: file => ["lib/auth.ts", "lib/settings.ts", "lib/safe-action.ts", "lib/env.ts", "lib/readable-error.ts"].includes(file),
    bans: (target, local) => local && under(target, "lib/ai"),
    message: "Every page and action loads this module, so it must not pull in the AI code. Move what it needs out of lib/ai into lib/ (AGENTS.md Project map).",
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
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  {
    files: ["app/**", "components/**", "lib/**", "workflows/**"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "lib/service-db.ts", "lib/service-keys.ts", "lib/supabase-server.ts", "workflows/financial-review.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{
        name: "@supabase/supabase-js",
        importNames: ["createClient"],
        message: "Use serviceDb() from lib/service-db.ts for the service role (it retries transient failures) or createClient() from lib/supabase-server.ts for the owner's session (AGENTS.md Rules).",
      }] }],
    },
  },
  {
    files: ["app/**", "components/**", "lib/**", "workflows/**"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "lib/cron.ts", "lib/scheduler.ts", "app/settings/**"],
    rules: {
      "no-restricted-properties": ["error", {
        object: "env",
        property: "CRON_SECRET",
        message: "Scheduled routes check the secret through cronRoute() in lib/cron.ts: export const GET = cronRoute(async () => { ... }) (AGENTS.md Rules).",
      }],
    },
  },
  {
    files: ["app/**", "components/**", "lib/**", "workflows/**", "*.ts"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "lib/env.ts", "lib/schema.ts", "lib/import/csv.ts", "workflows/**"],
    rules: { "no-restricted-syntax": ["error", ...hardCodedAddress, assumedTimeZone] },
  },
  {
    files: ["lib/schema.ts", "lib/import/csv.ts"],
    rules: { "no-restricted-syntax": ["error", ...hardCodedAddress] },
  },
  {
    files: ["workflows/**"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "no-restricted-syntax": ["error", ...hardCodedAddress, assumedTimeZone, unexplainedIgnoredFailure] },
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
