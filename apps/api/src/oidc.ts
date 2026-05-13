export interface GitHubActionsOidcClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  repository?: string;
  repository_owner?: string;
  ref?: string;
  sha?: string;
  workflow?: string;
  run_id?: string;
  run_attempt?: string;
  job_workflow_ref?: string;
  [key: string]: unknown;
}

export interface OidcValidationExpectation {
  audience?: string;
  repositoryFullName?: string;
  commitSha?: string;
  now?: Date;
}

export interface OidcValidationResult {
  ok: boolean;
  claims?: GitHubActionsOidcClaims;
  errors: string[];
}

export function decodeJwtPayloadWithoutVerifying(token: string): GitHubActionsOidcClaims {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("OIDC token is not a JWT.");
  }
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as GitHubActionsOidcClaims;
}

/**
 * Validates stable GitHub Actions OIDC claims after the caller has verified the JWT signature.
 * This local MVP intentionally keeps signature verification behind the hosted-service seam.
 */
export function validateGitHubActionsOidcClaims(
  claims: GitHubActionsOidcClaims,
  expectation: OidcValidationExpectation = {},
): OidcValidationResult {
  const errors: string[] = [];
  const nowSeconds = Math.floor((expectation.now ?? new Date()).getTime() / 1000);

  if (claims.iss !== "https://token.actions.githubusercontent.com") {
    errors.push("OIDC issuer must be https://token.actions.githubusercontent.com.");
  }
  if (claims.exp !== undefined && claims.exp <= nowSeconds) {
    errors.push("OIDC token is expired.");
  }
  if (claims.nbf !== undefined && claims.nbf > nowSeconds) {
    errors.push("OIDC token is not valid yet.");
  }
  if (expectation.audience) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(expectation.audience)) {
      errors.push(`OIDC audience must include '${expectation.audience}'.`);
    }
  }
  if (expectation.repositoryFullName && claims.repository !== expectation.repositoryFullName) {
    errors.push(`OIDC repository claim '${claims.repository ?? ""}' does not match '${expectation.repositoryFullName}'.`);
  }
  if (expectation.commitSha && claims.sha !== expectation.commitSha) {
    errors.push(`OIDC sha claim '${claims.sha ?? ""}' does not match '${expectation.commitSha}'.`);
  }

  return { ok: errors.length === 0, claims, errors };
}
