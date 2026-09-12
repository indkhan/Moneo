import { runMigrations } from "./migrate-lib.js";

await runMigrations();
console.log("migrations applied");
