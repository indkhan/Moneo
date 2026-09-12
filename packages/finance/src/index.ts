/**
 * @moneo/finance — canonical finance domain.
 *
 * Issue 2.2 owns the reusable command lifecycle (`./commands.js`); every
 * domain command in later epochs is a `CommandDefinition` run through
 * `executeCommand`, so web/worker/ai never duplicate mutation logic.
 */
export * from "./commands.js";
export * from "./balances.js";
export * from "./canonicalize.js";
export * from "./csv.js";
export * from "./duplicate-files.js";
export * from "./fx.js";
export * from "./mapping.js";
export * from "./xlsx.js";

export const FINANCE_PACKAGE = "@moneo/finance";
