import { SCHEMA_VERSION } from "@moneo/db/version";

export interface VersionInfo {
  gitSha: string;
  releaseId: string;
  schemaVersion: string;
  environment: string;
}

/** Release identity for GET /api/v1/version. No credentials, no provider details. */
export function getVersionInfo(): VersionInfo {
  return {
    gitSha: process.env.GIT_SHA ?? "local",
    releaseId: process.env.APP_RELEASE ?? "dev",
    schemaVersion: SCHEMA_VERSION,
    environment: process.env.APP_ENV ?? "development",
  };
}
