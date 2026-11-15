---
name: review-to-rule
description: Turn a review correction into a deterministic check (a lint rule, a type or a test) so it never needs saying again. Use when the owner corrects the same kind of mistake twice, says "stop doing X", "always do Y" or "make this a rule", or when a review comment could apply to future code as well as this diff.
---

# Turn a correction into a check

A correction written into AGENTS.md is read sometimes. A check runs every time. Use prose only for what needs human judgment.

## Steps

1. **State the rule in one sentence**, with the reason. If you cannot say why it matters, ask the owner before building anything.
2. **Pick the cheapest check that cannot be ignored**, in this order:
   - **A type.** Make the wrong code fail to compile: a required parameter instead of a default, a branded or narrowed type, a function that only accepts the safe input.
   - **A better API.** One helper in `lib/` that does it right, then a lint rule banning the raw form everywhere else.
   - **A lint rule** in `eslint.config.mjs`. Use `no-restricted-imports` for "this may not import that", `no-restricted-syntax` with an AST selector for "this call or shape is not allowed", `no-restricted-properties` for one member. Write a custom rule in the `moneo` plugin only when a selector cannot express it.
   - **A test**, when the rule is about behaviour and not about how the code is written. Follow AGENTS.md Tests: name the bug it would catch.
3. **Write the error message for an agent.** It must say what is wrong, why, and what to do instead, and point at the AGENTS.md section. "Don't do X" alone leaves the agent to guess; it will add an `eslint-disable`.
4. **Fix every existing violation in the same change.** A rule with a pile of disables teaches agents that disabling is normal. If there are too many to fix now, scope the rule to the folders that are already clean, open an issue for the rest, and widen it later.
5. **Prove it fires.** Lint a one-line bad sample and a good sample:
   `printf '%s\n' 'import { a } from "@/app/page"; export const b = a;' | npx eslint --stdin --stdin-filename lib/sample.ts`
   Flat config replaces a rule's options when two blocks match the same file, so check a file from every folder the rule should cover.
6. **Trim the prose.** If AGENTS.md already carried this rule as a sentence, shorten it to a pointer at the check, or delete it.
7. Run `npm run lint`, `npm run typecheck` and `npm test`.

## Do not

- Add an `eslint-disable` to make the new rule pass.
- Write a rule that greps source text or asserts copy.
- Encode a one-off preference about this diff. If it will not recur, just fix the code.
