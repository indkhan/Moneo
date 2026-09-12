import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // drizzle-kit CLI only. Runtime uses DATABASE_URL / DATABASE_MIGRATION_URL.
    url: process.env.DATABASE_URL ?? "postgres://moneo:moneo@localhost:5432/moneo",
  },
});
