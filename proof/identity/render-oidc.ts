// E00-S05 identity proof: Render managed OIDC readiness gate.
//
// Encodes the live Render OIDC documentation (checked 2026-09-17) as a pure
// readiness check: Pro workspace or higher, workspace ID from the dashboard,
// AWS IAM identity provider + per-service role trust, role ARN wired via the
// AWS_ROLE_ARN service variable. No permanent keys, no silent fallback.
// The live federation test stays Blocked until the founder supplies the
// inputs named in each verdict (see REPORT.md).

export type WorkspacePlan = "free" | "starter" | "pro" | "unknown";

export interface RenderOidcInputs {
  workspacePlan: WorkspacePlan;
  workspaceIdKnown: boolean;
  awsIdentityProviderConfigured: boolean;
  roleArnKnown: boolean;
  // Least-privilege shape: one narrowly scoped role per service.
  // Render assigns exactly one role per service via AWS_ROLE_ARN.
  singleRolePerService: boolean;
}

export type RenderOidcVerdict =
  | { ready: true; note: string }
  | { ready: false; blockedBy: string; founderInput: string };

export function checkRenderOidcReadiness(inputs: RenderOidcInputs): RenderOidcVerdict {
  if (inputs.workspacePlan !== "pro") {
    return {
      ready: false,
      blockedBy: "render-managed-oidc-plan",
      founderInput:
        "Render workspace on Pro plan or higher (managed OIDC is plan-gated); " +
        "founder confirms the workspace plan in the Render dashboard Settings.",
    };
  }
  if (!inputs.workspaceIdKnown) {
    return {
      ready: false,
      blockedBy: "render-workspace-id",
      founderInput:
        "Render workspace ID (starts with tea-) from the dashboard Settings page; " +
        "needed as the OIDC issuer https://oidc.render.com/{WORKSPACE_ID}.",
    };
  }
  if (!inputs.awsIdentityProviderConfigured) {
    return {
      ready: false,
      blockedBy: "aws-iam-identity-provider",
      founderInput:
        "AWS IAM OIDC identity provider for oidc.render.com/{WORKSPACE_ID} " +
        "(audience sts.amazonaws.com) plus a trust policy scoping " +
        "workspace/environment/service subjects; founder creates it in IAM.",
    };
  }
  if (!inputs.roleArnKnown || !inputs.singleRolePerService) {
    return {
      ready: false,
      blockedBy: "aws-role-arn",
      founderInput:
        "ARN of one narrowly scoped IAM role (least-privilege S3/KMS actions " +
        "only) set as the service AWS_ROLE_ARN variable; one role per service.",
    };
  }
  return {
    ready: true,
    note: "config complete; live AssumeRoleWithWebIdentity still needs a deployed Render service to test",
  };
}

// Static keys must never be the quiet fallback when OIDC is unavailable.
export function allowStaticAwsKeys(reason: string): { allowed: false; reason: string } {
  return {
    allowed: false,
    reason: `permanent AWS keys refused (${reason}); use OIDC federation (§370)`,
  };
}
