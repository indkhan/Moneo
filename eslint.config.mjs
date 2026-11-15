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

const toolDirective = /^(\s*eslint-|\s*@ts-(expect-error|ignore|nocheck)|\s*(turbopack|webpack)Ignore:|\s*@vitest-environment|\*\s*@type\s|\/\s*<reference\s)/;

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
          if (comment.type === "Shebang" || toolDirective.test(comment.value)) continue;
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
              return fixer.removeRange([start, opensLine ? lineEnd : end]);
            },
          });
        }
      },
    };
  },
};

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    plugins: { moneo: { rules: { "no-comments": noComments } } },
    rules: { "moneo/no-comments": "error" },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "e2e/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...realWait, dynamicSkip] },
  },
  {
    files: ["e2e/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...realWait, dynamicSkip, ownerApp] },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    ignores: migrationReaders,
    rules: { "no-restricted-syntax": ["error", ...realWait, dynamicSkip, migrationText] },
  },
  globalIgnores([".next/**", ".next-qa/**", "out/**", "build/**", "next-env.d.ts", "app/.well-known/workflow/**", ".qa/**", ".claude/**", "promo/**", ".next-desktop/**", "desktop/.build/**", "desktop/.cache/**", "desktop/dist/**", "desktop/release/**", "desktop/release-preview/**"]),
]);
