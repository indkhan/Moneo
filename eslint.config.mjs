import path from "node:path";
import indexedAccess from "./tsconfig.indexed.json" with { type: "json" };
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

const exactMoney = [
  {
    selector: "NewExpression[callee.object.name='Intl'][callee.property.name='NumberFormat'] Property[key.name='style'][value.value='currency']",
    message: "Currency formatting through Intl takes a float and rounds cents. Use formatMoney or formatCompactMoney from lib/finance/format.ts with integer minor units (AGENTS.md Non-negotiables).",
  },
  {
    selector: "CallExpression[callee.property.name='toLocaleString'] Property[key.name='currency']",
    message: "toLocaleString with a currency takes a float and rounds cents. Use formatMoney from lib/finance/format.ts with integer minor units (AGENTS.md Non-negotiables).",
  },
  {
    selector: "BinaryExpression[operator='/'] > BinaryExpression[operator='**'][left.value=10][right.callee.name='minorDigits']",
    message: "Dividing by 10 ** minorDigits() turns minor units into a float. Keep amounts as bigint minor units and format them with lib/finance/format.ts (AGENTS.md Non-negotiables).",
  },
  {
    selector: ":matches(CallExpression[callee.name='Number'], CallExpression[callee.name='parseFloat']) > CallExpression[callee.name='formatInputAmount']",
    message: "Number(formatInputAmount()) turns an exact amount into a float. Pass the bigint minor units to formatMoney, or plot Number(minor) and format ticks with formatCompactMoney (AGENTS.md Non-negotiables).",
  },
  {
    selector: "TemplateLiteral:has(CallExpression[callee.property.name='toFixed']):has(:matches(Identifier[name=/^currency(Code)?$/], MemberExpression[property.name=/^currency(Code|_code)?$/]))",
    message: "toFixed on an amount shown next to its currency rounds a float. Use formatMoney from lib/finance/format.ts with integer minor units (AGENTS.md Non-negotiables).",
  },
];

const unexplainedIgnoredFailure = {
  selector: ":matches(CatchClause > BlockStatement[body.length=0], CallExpression[callee.property.name='catch'] > :matches(ArrowFunctionExpression, FunctionExpression) > BlockStatement[body.length=0], CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='Identifier'][body.name='undefined'], CallExpression[callee.property.name='then'][arguments.length=2] > :matches(ArrowFunctionExpression, FunctionExpression):last-child > BlockStatement[body.length=0])",
  message: "Ignoring a failure must say what handles it instead. Return an actionable failure, record the outcome, or call a function named for that reason, as workflows/bank-sync.ts does (catch { hourlyBacklogCheckPicksUpTheRows(); }) (AGENTS.md How to work, \"Fix the class\").",
};

const typedAsyncFiles = ["lib/**/*.ts", "lib/**/*.tsx", "workflows/**/*.ts", "app/**/actions.ts", "app/**/*-actions.ts", "app/**/*-action.ts", "app/**/route.ts"];

const rawTimer = {
  selector: ":matches(CallExpression[callee.name=/^(setTimeout|setInterval)$/], CallExpression[callee.object.name='window'][callee.property.name=/^(setTimeout|setInterval)$/])",
  message: "A raw timer outlives its component and doubles under Strict Mode. Repeat work with usePolling or useNow (lib/use-polling.ts, lib/use-now.ts); delay with useTimeout or useDelay (lib/use-timeout.ts) (AGENTS.md Rules).",
};

const serverActionFilesWithTimers = ["app/settings/ai-access.tsx"];

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
  {
    applies: file => under(file, "lib/finance") && !isTest(file),
    bans: target => ["lib/auth", "lib/settings"].includes(target),
    message: "Financial calculations take plain inputs. The caller resolves the owner, settings, AI scopes and clock (lib/auth, lib/settings) and passes them in; setting types and AI scope names live in lib/workspace-settings (AGENTS.md Non-negotiables).",
  },
];

const noProcessEnv = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      banned: "Read configuration through the typed accessors in lib/env.ts. Add one there with a Zod schema if it is missing, so a bad value names its variable and a missing optional provider never stops the app (AGENTS.md Rules).",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.object.name !== "process" || node.property.name !== "env" || node.computed) return;
        const parent = node.parent;
        const buildMode = parent.type === "MemberExpression" && parent.object === node && !parent.computed && parent.property.name === "NODE_ENV";
        if (!buildMode) context.report({ node, messageId: "banned" });
      },
    };
  },
};

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
    plugins: { moneo: { rules: { "no-comments": noComments, "import-boundaries": importBoundaries, "no-process-env": noProcessEnv } } },
    rules: { "moneo/no-comments": "error", "moneo/import-boundaries": "error" },
  },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  {
    files: indexedAccess.include,
    rules: { "@typescript-eslint/no-non-null-assertion": ["error"] },
  },
  {
    files: ["app/**", "components/**", "lib/**", "workflows/**", "proxy.ts", "instrumentation-node.ts"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.live.test.ts", "lib/env.ts", "lib/property-check.ts"],
    rules: { "moneo/no-process-env": "error" },
  },
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
    ignores: ["**/*.test.ts", "**/*.test.tsx", "lib/env.ts", "lib/finance/format.ts", "lib/schema.ts", "lib/import/csv.ts", "workflows/**"],
    rules: { "no-restricted-syntax": ["error", ...hardCodedAddress, assumedTimeZone, ...exactMoney] },
  },
  {
    files: ["app/**", "components/**"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "app/api/**", ...typedAsyncFiles, ...serverActionFilesWithTimers],
    rules: { "no-restricted-syntax": ["error", ...hardCodedAddress, assumedTimeZone, ...exactMoney, rawTimer] },
  },
  {
    files: ["lib/schema.ts", "lib/import/csv.ts"],
    rules: { "no-restricted-syntax": ["error", ...hardCodedAddress, ...exactMoney] },
  },
  {
    files: ["workflows/**", ...typedAsyncFiles],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "lib/env.ts", "lib/finance/format.ts", "lib/schema.ts", "lib/import/csv.ts"],
    rules: { "no-restricted-syntax": ["error", ...hardCodedAddress, assumedTimeZone, ...exactMoney, unexplainedIgnoredFailure] },
  },
  {
    files: ["lib/schema.ts", "lib/import/csv.ts"],
    rules: { "no-restricted-syntax": ["error", ...hardCodedAddress, ...exactMoney, unexplainedIgnoredFailure] },
  },
  {
    files: ["lib/finance/format.ts"],
    rules: { "no-restricted-syntax": ["error", ...hardCodedAddress, assumedTimeZone, unexplainedIgnoredFailure] },
  },
  {
    files: ["lib/env.ts"],
    rules: { "no-restricted-syntax": ["error", unexplainedIgnoredFailure] },
  },
  {
    files: typedAsyncFiles,
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
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
