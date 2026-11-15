---
name: state-chart
description: Draw the state machine of a Moneo flow as a diagram the owner can review, taken from the code. Use when a change adds or alters a multi-step flow (import, bank connect and reconnect, Scalable orders, proposal cards, voice call, agent runs, desktop start-up), when asked to "draw the states", "show the flow" or "state chart", or when a bug looks like an unhandled transition.
---

# Draw a flow's state machine

A diagram of states and transitions shows a missing case faster than a diff does. Build it from the code, never from memory of how the flow should work.

## Steps

1. **Find where the state lives.** Usually a status column in `lib/schema.ts` (and its check constraint in `supabase/migrations/`), a union type, or a workflow in `workflows/`. List every value it can take.
2. **Find every transition.** Grep for each write to that status and each place it is compared. For each one record: from, to, what triggers it (owner tap, AI proposal, background job, bank callback, timeout, failure) and the file and line.
3. **Check it for holes.** Answer each of these from the code:
   - Is every state reachable, and can every state that is not final be left?
   - What happens on failure, on a second tap, and when two devices act at once?
   - What does undo, disconnect and "reset all data" do from each state?
   - What happens if the app quits mid-transition and starts again?

   A question with no answer in the code is a finding. Report it; do not paper over it in the diagram.
4. **Draw it** as Mermaid `stateDiagram-v2`. Name states the way the owner sees them in the app, with the stored value in brackets when it differs. Label each arrow with its trigger. Mark AI-triggered transitions and the ones that need a card the owner accepts.

   ```mermaid
   stateDiagram-v2
     [*] --> Uploaded
     Uploaded --> Reviewing: columns recognised
     Uploaded --> Failed: file unreadable
     Reviewing --> Imported: owner confirms
     Imported --> Uploaded: undo
     Failed --> [*]
   ```

5. **Show it.** For a PR, put the diagram in the description next to the screenshots, with the list of holes from step 3 under it. When the change alters a flow, show the diagram before and after. In chat, render it instead of pasting the source if a preview tool is available.

## Do not

- Commit the diagram to the repo. It goes stale like a comment; regenerate it from the code when needed.
- Invent states or transitions to make the picture tidy.
