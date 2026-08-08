# Moneo agent guide

## Product

Moneo is a calm, insight-first personal-finance app.

The MVP helps one person understand their money through accounts, transactions, budgets, recurring payments, investments, and AI-led explanations.

Build the smallest vertical slice that makes a feature genuinely useful.

Financial data must be accurate, traceable, and clearly labelled. Never silently invent, mutate, or present mock data as real.

## Stack

* Expo SDK 57
* React 19
* React Native
* TypeScript
* Expo Router
* React Native SVG
* `@/` resolves to `src/`

Structure:

* `src/app/` — file-based routes
* Screens delegate to `FinanceWorkspace` in `src/components/finance-workspace.tsx`
* `src/lib/` — small pure helpers with Node tests
* Desktop breakpoint: `>= 1024px`

Preserve the desktop sidebar/multi-column layout and mobile stacked/bottom-nav layout.

## Before coding

* Read the exact Expo SDK 57 docs for any Expo/React Native API you change.
* Inspect the existing implementation before introducing new patterns.
* check `application.md` as well before something to know what other things are there 
* State important assumptions when the task is ambiguous.
* Prefer the simplest solution that satisfies the request.
* Do not add speculative features or abstractions.

## Implementation

1. Keep changes small and local.
2. Extend existing screens and helpers before adding architecture or dependencies.
3. Preserve TypeScript `strict` compatibility.
4. Keep calculation and layout logic pure and testable in `src/lib/` when practical.
5. Reuse the existing visual language: muted backgrounds, white cards, teal accents, rounded panels, and responsive layouts.
6. Do not refactor unrelated code or alter financial mock values unless required.
7. Remove only unused code created by your own changes.
8. Once done with things in very very consice way edit `application.md` as per what you edited

## Financial integrations

Treat bank, investment, and AI integrations as product features, not simple API calls.

Before connecting a service, define:

* Loading
* Empty
* Error
* Consent
* Privacy

Never commit secrets, credentials, or access tokens.

Do not pretend an integration works before it actually exists.

## Validation

After relevant changes:

* `npm test`
* `npx tsc --noEmit`
* Run the appropriate Expo target:

  * `npm start`
  * `npm run web`
  * `npm run android`
  * `npm run ios`

For UI or routing changes, verify both mobile and desktop layouts when applicable.

## Definition of done

A task is done when:

* The requested behavior works.
* Relevant tests pass.
* TypeScript passes.
* Existing behavior is not unnecessarily changed.
* The diff contains only changes directly related to the task.

## Current gaps

Moneo currently has no:

* Authentication
* Database or persistence
* Bank/API connection
* Real AI integration
* Notifications
* Settings
* Dashboard pinning

Add these deliberately. Never fake their completion in the UI or documentation.
dont commit on your name commit it as my name only 