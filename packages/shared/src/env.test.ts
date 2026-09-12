import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  const localEnvFile = resolve(import.meta.dirname, "../../..", ".env");

  it.skipIf(!existsSync(localEnvFile))("loads the repository local environment file for workspace processes", () => {
    const localEnv = readFileSync(localEnvFile, "utf8");
    const databaseUrl = localEnv.match(/^DATABASE_URL=(.+)$/m)?.[1];

    expect(databaseUrl).toBeTruthy();
    expect(loadEnv().DATABASE_URL).toBe(databaseUrl);
  });
});
