import type { AppEnv } from "./env.js";

export interface ReleaseIdentity {
  gitSha: string;
  releaseId: string;
  environment: AppEnv["APP_ENV"];
}

export function getReleaseIdentity(
  env: Pick<AppEnv, "GIT_SHA" | "APP_RELEASE" | "APP_ENV">,
): ReleaseIdentity {
  return {
    gitSha: env.GIT_SHA,
    releaseId: env.APP_RELEASE,
    environment: env.APP_ENV,
  };
}
