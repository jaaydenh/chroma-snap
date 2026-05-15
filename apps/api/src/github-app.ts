import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { GitHubCheckRunRequest } from "@chroma-snap/shared";

export interface GitHubAppConfig {
  appId: number;
  privateKeyPem: string;
  apiBaseUrl?: string;
}

export interface GitHubCheckPublisher {
  createCheckRun(input: {
    installationId: number;
    repositoryFullName: string;
    request: GitHubCheckRunRequest;
  }): Promise<{ githubCheckRunId: number }>;
  updateCheckRun(input: {
    installationId: number;
    repositoryFullName: string;
    githubCheckRunId: number;
    request: GitHubCheckRunRequest;
  }): Promise<void>;
}

export class GitHubAppClient implements GitHubCheckPublisher {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GitHubAppConfig, fetchImpl: typeof fetch = fetch) {
    this.apiBaseUrl = config.apiBaseUrl ?? "https://api.github.com";
    this.fetchImpl = fetchImpl;
  }

  async createCheckRun(input: {
    installationId: number;
    repositoryFullName: string;
    request: GitHubCheckRunRequest;
  }): Promise<{ githubCheckRunId: number }> {
    const token = await this.getInstallationAccessToken(input.installationId);
    const response = await this.fetchImpl(`${this.apiBaseUrl}/repos/${input.repositoryFullName}/check-runs`, {
      method: "POST",
      headers: githubJsonHeaders(token),
      body: JSON.stringify(toGitHubCheckRunBody(input.request)),
    });
    if (!response.ok) {
      throw new Error(`GitHub check run creation failed with ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { id?: number };
    if (typeof body.id !== "number") {
      throw new Error("GitHub check run creation response did not include a numeric id.");
    }
    return { githubCheckRunId: body.id };
  }

  async updateCheckRun(input: {
    installationId: number;
    repositoryFullName: string;
    githubCheckRunId: number;
    request: GitHubCheckRunRequest;
  }): Promise<void> {
    const token = await this.getInstallationAccessToken(input.installationId);
    const response = await this.fetchImpl(`${this.apiBaseUrl}/repos/${input.repositoryFullName}/check-runs/${input.githubCheckRunId}`, {
      method: "PATCH",
      headers: githubJsonHeaders(token),
      body: JSON.stringify(toGitHubCheckRunBody(input.request)),
    });
    if (!response.ok) {
      throw new Error(`GitHub check run update failed with ${response.status}: ${await response.text()}`);
    }
  }

  async getInstallationAccessToken(installationId: number): Promise<string> {
    const jwt = createGitHubAppJwt(this.config.appId, this.config.privateKeyPem);
    const response = await this.fetchImpl(`${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: githubJsonHeaders(jwt),
    });
    if (!response.ok) {
      throw new Error(`GitHub installation token request failed with ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { token?: string };
    if (!body.token) {
      throw new Error("GitHub installation token response did not include a token.");
    }
    return body.token;
  }
}

export function verifyGitHubWebhookSignature(secret: string, payload: Uint8Array, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const actual = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(payload).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function signGitHubWebhookPayload(secret: string, payload: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export function createGitHubAppJwt(appId: number, privateKeyPem: string, now: Date = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat: issuedAt, exp: expiresAt, iss: String(appId) });
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKeyPem).toString("base64url")}`;
}

function toGitHubCheckRunBody(request: GitHubCheckRunRequest): Record<string, unknown> {
  return {
    name: request.name,
    head_sha: request.headSha,
    status: request.status,
    ...(request.conclusion && request.status === "completed" ? { conclusion: request.conclusion } : {}),
    ...(request.detailsUrl ? { details_url: request.detailsUrl } : {}),
    output: request.output,
  };
}

function githubJsonHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
