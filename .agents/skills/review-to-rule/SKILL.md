---
name: review-to-rule
description: Turn a correction into something the codebase enforces (a better design, a type, a lint rule or a test) so it never needs saying again. Use when the owner corrects a mistake, says "stop doing X", "always do Y" or "make this a rule", when the same fix is needed a second time, or when the tempting fix is another sentence in AGENTS.md or in the assistant's system prompt.
---

# Turn a correction into a check

Assume the next contributor is an agent that sees only the files it opened, copies the nearest example and takes the shortest path that compiles. A sentence in AGENTS.md is read sometimes; a check runs every time. The instruction is the symptom: change the code so the mistake cannot be made.

This applies to the product as well. When the assistant in the app gets a request wrong, a sentence in its system prompt (`lib/ai/provider.ts`, `lib/ai/voice-*`) naming that request is the same symptom fix. See step 2.

## Steps

1. **Name the class, not the case.** State the rule in one sentence with its reason. Then find every other place with the same fault: grep for the pattern, and check recent commits, reverts and review comments for earlier instances. If you cannot say why it matters, ask the owner before building anything.
2. **Fix it at the highest level that works**, in this order:
   - **Design.** Give each piece of state one owner and each job one supported way. Replace hand-synced lists with one source of truth. Delete the old way and any dead code an agent would copy. For the in-app assistant: give it the tool, the data or the scope it lacked, so this request and every similar one works.
   - **A type.** Make the wrong code fail to compile: a required parameter instead of a default, a narrowed or branded type, a function that only accepts the safe input.
   - **A lint rule** in `eslint.config.mjs`, when wrong code still compiles. `moneo/import-boundaries` covers "this may not import that"; `no-restricted-syntax` with an AST selector covers "this call or shape is not allowed"; `no-restricted-properties` covers one member. Add a rule to the `moneo` plugin only when a selector cannot express it.
   - **A test**, when the rule is about behaviour. Follow AGENTS.md Tests.
   - **Prose in AGENTS.md**, last, only for judgment calls. Nothing fails when an agent skips it.

   In your reply, say which level you picked and why the one above it did not work.
3. **Write the error for an agent.** It says what is wrong, why, and the file, type or function to use instead, and it names the AGENTS.md section. "Don't do X" alone gets an `eslint-disable`.
4. **Fix every existing violation in the same change.** A rule with a pile of disables teaches that disabling is normal. If there are too many, scope the rule to the folders that are already clean, or make it fail only when a change adds more, and open an issue for the rest.
5. **Prove the check fails on the real mistake.** Reproduce the original mistake (the old line, the old import) and watch the check reject it; then confirm the fixed code passes.
   `printf '%s\n' 'import { a } from "@/app/page"; export const b = a;' | npx eslint --stdin --stdin-filename lib/sample.ts`
   Two config blocks that match one file replace each other's options for the same rule, so try a file from every folder the rule should cover.
6. **Update the rule table** in AGENTS.md ("Rules and what enforces them"): add the rule with its check. If the rule was there as a sentence, replace the sentence with the table row. Remove a row once the mistake can no longer be written at all.
7. Run `npm run lint`, `npm run typecheck` and `npm test`.

## Do not

- Add an `eslint-disable`, a guard, a retry or a swallowed error to get to green.
- Add a sentence to a system prompt that names one request, keyword or example to make that one case work.
- Write a check that greps source text or asserts copy.
- Encode a one-off preference about this diff. If it will not recur, just fix the code.
