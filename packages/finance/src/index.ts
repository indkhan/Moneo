/**
 * @moneo/finance — canonical finance domain.
 *
 * Issue 2.2 owns the reusable command lifecycle (`./commands.js`); every
 * domain command in later epochs is a `CommandDefinition` run through
 * `executeCommand`, so web/worker/ai never duplicate mutation logic.
 */
export * from "./commands.js";
export * from "./csv.js";

export const FINANCE_PACKAGE = "@moneo/finance";
