---
name: state-chart
description: Draw the state machine of a Moneo flow as a diagram the owner can review, taken from the code, and list the paths that break a rule. Use when a change adds or alters a multi-step flow (import, bank connect and reconnect, Scalable orders, proposal cards, voice call, agent runs, desktop start-up), when asked to "draw the states", "show the flow" or "state chart", or to show a bug as a path through states.
---

# Draw a flow's state machine

The owner decides whether the behaviour is right, so the chart is in their words. Build it from the code, never from memory of how the flow should work.

## Steps

1. **Write the rules first.** List what must always hold, in sentences the owner would agree with: "an order is sent at most once", "undo puts back exactly what the import added", "nothing is written until the card is accepted". These are what the chart is checked against.
2. **Find where the state lives.** `FEATURES.md` lists the flow's pages, chat tools, workflows and undo paths. Usually a status column in `lib/schema.ts` (and its check constraint in `supabase/migrations/`), a union type, or a workflow in `workflows/`. List every value it can take.
3. **Find every transition.** Grep for each write to that status and each place it is compared. For each one record: from, to, what triggers it and the file and line.
4. **Walk it for holes.** Answer each from the code:
   - Is every state reachable, and can every state that is not final be left?
   - What happens on failure, on a second tap, and when two devices act at once?
   - What do undo, disconnect and "reset all data" do from each state?
   - What happens if the app quits mid-transition and starts again?

   For each rule from step 1, look for the shortest path of steps that breaks it. A question the code does not answer is a finding. Never weaken a rule or tidy the chart to hide one.
5. **Draw it** as Mermaid `stateDiagram-v2`.
   - Label a state with what the owner sees or cares about ("Reviewing", "Order sent, answer unknown"), not a variable name. Add the stored value in brackets only when it helps.
   - Label an arrow with the step as the owner sees it happen: "you confirm", "the bank says no", "Moneo restarts". Not a function name.
   - Mark the arrows the AI triggers and the ones that need an accepted card.
   - Aim for 20 arrows or fewer. Merge states that behave the same; never merge two states that break different rules.
   - Give every state that breaks a rule the class `breaks`.

   ```mermaid
   stateDiagram-v2
     classDef breaks fill:#fde2e2,stroke:#b42318
     [*] --> Uploaded
     Uploaded --> Reviewing: columns recognised
     Uploaded --> Failed: file unreadable
     Reviewing --> Imported: you confirm
     Imported --> Uploaded: you undo
     Reviewing --> Stuck: Moneo restarts
     class Stuck breaks
   ```

6. **Replay each broken path against the real code.** Write it as a failing test or a live repro, one step per arrow. If the bug does not happen, assume the chart is wrong until you show it is not.
7. **Hand it over.** In the PR description or in chat (rendered, not as source, when a preview tool is available): the chart, one line per broken rule with its path, and what the chart leaves out. When a change alters a flow, show the chart before and after.

## Do not

- Commit the chart to the repo. It goes stale like a comment; draw it again from the code.
- Invent states or transitions to make the picture tidy.
