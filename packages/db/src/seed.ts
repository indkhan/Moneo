import { loadEnv } from "@moneo/shared/env";
import { seed } from "./seed-lib.js";

// Reference data is seeded by the release-time owner, never the restricted
// application role that serves requests.
const env = loadEnv();
process.env.DATABASE_URL = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;
await seed();
