import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Test rules from AGENTS.md "Tests".
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

// Port 3000 is the owner's app; tests reach only the QA server through the configured base URL.
const ownerApp = {
  selector: ":matches(Literal[value=/(localhost|127\.0\.0\.1):3000/], TemplateElement[value.raw=/(localhost|127\.0\.0\.1):3000/])",
  message: "Port 3000 is the owner's app. Use the base URL from playwright.config.ts (the QA server on 3100) (AGENTS.md Test backend).",
};

// Unit tests that apply or replay migrations on purpose.
const migrationReaders = [
  "lib/schema.test.ts",
  "lib/finance/currency-precision-contract.test.ts",
  "supabase/tests/**",
  "**/*.live.test.ts",
];

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
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
