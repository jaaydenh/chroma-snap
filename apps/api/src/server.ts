import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertValidManifest,
  checkOutputForComparisonReport,
  checkOutputForQueuedBuild,
  DEFAULT_GITHUB_CHECK_NAME,
  FileArtifactStore,
  FileBaselineStore,
  FileComparisonStore,
  strictCheckConclusionForReport,
  type ArtifactStore,
  type BaselineLookupInput,
  type BaselineRecord,
  type BaselineStore,
  type ComparisonReport,
  type ComparisonStore,
  type CreateUploadSessionRequest,
  type FinalizeUploadSessionRequest,
  type FinalizeUploadSessionResponse,
  type GitHubCheckRunRecord,
  type GitHubCheckRunRequest,
  type GitHubInstallationRecord,
  type GitHubPullRequestRecord,
  type GitHubRefRecord,
  type GitHubRepositoryDescriptor,
  type GitHubWebhookEventRecord,
  type UploadSessionResponse,
} from "@chroma-snap/shared";
import { type GitHubCheckPublisher, verifyGitHubWebhookSignature } from "./github-app.js";
import { FileGitHubIntegrationStore, type GitHubIntegrationStore } from "./github-store.js";
import { decodeJwtPayloadWithoutVerifying, validateGitHubActionsOidcClaims } from "./oidc.js";
import { objectKeyForArtifact, type StoredSession } from "./session.js";
import { verifyUploadIntegrity } from "./upload-integrity.js";

export interface ApiServerOptions {
  host?: string;
  port?: number;
  storageDir?: string;
  publicUrl?: string;
  /** Development-only escape hatch for local CLI tests without GitHub OIDC. */
  allowDevAuth?: boolean;
  artifactStore?: ArtifactStore;
  baselineStore?: BaselineStore;
  comparisonStore?: ComparisonStore;
  githubStore?: GitHubIntegrationStore;
  githubCheckPublisher?: GitHubCheckPublisher;
  githubWebhookSecret?: string;
  githubCheckName?: string;
  oidcAudience?: string;
}

interface StoredBuildRecord {
  buildId: string;
  sessionId: string;
  repository: { fullName: string; installationId?: string };
  git: { commitSha: string; branch: string; baseBranch?: string };
  project: { name: string };
  status: "queued" | "processing" | "completed" | "failed";
  createdAt: string;
  finalizedAt?: string;
  comparedAt?: string;
  checkConclusion?: ComparisonReport["checkConclusion"];
  summary?: ComparisonReport["summary"];
}

export async function startApiServer(options: ApiServerOptions = {}): Promise<{ server: Server; url: string }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4007;
  const storageDir = resolve(options.storageDir ?? ".chroma-snap/server");
  const artifactStore = options.artifactStore ?? new FileArtifactStore(storageDir);
  const baselineStore = options.baselineStore ?? new FileBaselineStore(resolve(storageDir, "baselines.json"));
  const comparisonStore = options.comparisonStore ?? new FileComparisonStore(resolve(storageDir, "comparisons.json"));
  const githubStore = options.githubStore ?? new FileGitHubIntegrationStore(storageDir);
  let publicUrl = options.publicUrl ?? `http://${host}:${port}`;
  await mkdir(storageDir, { recursive: true });

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, { ...options, host, port, storageDir, publicUrl, artifactStore, baselineStore, comparisonStore, githubStore });
    } catch (error) {
      sendJson(res, error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolveListen) => server.listen(port, host, resolveListen));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  publicUrl = options.publicUrl ?? `http://${host}:${actualPort}`;
  return { server, url: publicUrl };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: Required<Pick<ApiServerOptions, "host" | "port" | "storageDir" | "publicUrl" | "artifactStore" | "baselineStore" | "comparisonStore" | "githubStore">> & ApiServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", options.publicUrl);

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/v1/github/webhooks" || url.pathname === "/v1/webhooks/github")) {
    const payload = await readBody(req);
    const response = await handleGitHubWebhook(req, payload, options);
    sendJson(res, 202, response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/upload-sessions") {
    await assertUploadAuth(req, options);
    const body = await readJson<CreateUploadSessionRequest>(req);
    const session = await createUploadSession(body, options);
    sendJson(res, 201, session);
    return;
  }

  const uploadMatch = url.pathname.match(/^\/v1\/upload-sessions\/([^/]+)\/artifacts\/([^/]+)$/);
  if (req.method === "PUT" && uploadMatch) {
    const [, sessionId, artifactId] = uploadMatch;
    await putArtifact(req, options.storageDir, options.artifactStore, sessionId!, artifactId!);
    sendJson(res, 200, { ok: true });
    return;
  }

  const finalizeMatch = url.pathname.match(/^\/v1\/upload-sessions\/([^/]+)\/finalize$/);
  if (req.method === "POST" && finalizeMatch) {
    await assertUploadAuth(req, options);
    const body = await readJson<FinalizeUploadSessionRequest>(req);
    const response = await finalizeUploadSession(finalizeMatch[1]!, body, options);
    sendJson(res, 202, response);
    return;
  }

  const baselineMatch = url.pathname.match(/^\/v1\/builds\/([^/]+)\/baselines$/);
  if (req.method === "GET" && baselineMatch) {
    const build = await readBuildRecord(options.storageDir, baselineMatch[1]!);
    const branch = url.searchParams.get("branch") ?? build.git.baseBranch ?? build.git.branch;
    const identityKey = url.searchParams.get("identityKey") ?? undefined;
    if (identityKey) {
      const baseline = await options.baselineStore.lookupBaseline({
        repositoryFullName: build.repository.fullName,
        projectName: build.project.name,
        branch,
        identityKey,
      });
      if (!baseline) {
        throw new HttpError(404, "Baseline not found.");
      }
      sendJson(res, 200, { baseline });
      return;
    }

    const baselines = await options.baselineStore.listBaselinesForBranch({
      repositoryFullName: build.repository.fullName,
      projectName: build.project.name,
      branch,
    });
    sendJson(res, 200, { baselines });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/v1/baselines") {
    await assertUploadAuth(req, options);
    const body = await readJson<{ baseline?: BaselineRecord; baselines?: BaselineRecord[] }>(req);
    const baselines = Array.isArray(body.baselines) ? body.baselines : body.baseline ? [body.baseline] : [];
    if (baselines.length === 0) {
      throw new HttpError(400, "baseline or baselines is required.");
    }
    await options.baselineStore.promoteBaselines(baselines);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/v1/baselines") {
    await assertUploadAuth(req, options);
    const body = await readJson<BaselineLookupInput>(req);
    await options.baselineStore.deleteBaseline(body);
    sendJson(res, 200, { ok: true });
    return;
  }

  const comparisonMatch = url.pathname.match(/^\/v1\/builds\/([^/]+)\/comparison-report$/);
  if (comparisonMatch && (req.method === "PUT" || req.method === "POST")) {
    await assertUploadAuth(req, options);
    const body = await readJson<{ report?: ComparisonReport }>(req);
    if (!body.report) {
      throw new HttpError(400, "report is required.");
    }
    if (body.report.buildId !== comparisonMatch[1]) {
      throw new HttpError(400, "Comparison report buildId does not match URL.");
    }
    const build = await readBuildRecord(options.storageDir, comparisonMatch[1]!);
    await options.comparisonStore.saveComparisonReport(body.report);
    await markBuildCompared(options, build, body.report);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (comparisonMatch && req.method === "GET") {
    const report = await options.comparisonStore.getComparisonReport(comparisonMatch[1]!);
    if (!report) {
      throw new HttpError(404, "Comparison report not found.");
    }
    sendJson(res, 200, { report });
    return;
  }

  const checkRunMatch = url.pathname.match(/^\/v1\/builds\/([^/]+)\/check-run$/);
  if (checkRunMatch && req.method === "GET") {
    const checkRun = await options.githubStore.getCheckRunByBuildId(checkRunMatch[1]!);
    if (!checkRun) {
      throw new HttpError(404, "Check run not found.");
    }
    sendJson(res, 200, { checkRun });
    return;
  }

  if (checkRunMatch && req.method === "POST") {
    await assertUploadAuth(req, options);
    const build = await readBuildRecord(options.storageDir, checkRunMatch[1]!);
    const report = await options.comparisonStore.getComparisonReport(checkRunMatch[1]!);
    const checkRun = await publishGitHubCheckRun(build, report, options);
    sendJson(res, 202, { checkRun });
    return;
  }

  const buildMatch = url.pathname.match(/^\/v1\/builds\/([^/]+)$/);
  if (req.method === "GET" && buildMatch) {
    const build = await readBuildRecord(options.storageDir, buildMatch[1]!);
    sendJson(res, 200, build);
    return;
  }

  throw new HttpError(404, "Not found");
}

async function createUploadSession(body: CreateUploadSessionRequest, options: Required<Pick<ApiServerOptions, "storageDir" | "publicUrl">> & ApiServerOptions): Promise<UploadSessionResponse> {
  if (!body.repository?.fullName || !body.git?.commitSha || !body.configHash) {
    throw new HttpError(400, "repository.fullName, git.commitSha, and configHash are required.");
  }

  const sessionId = randomUUID();
  const buildId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const session: StoredSession = {
    sessionId,
    buildId,
    createdAt: new Date().toISOString(),
    expiresAt,
    request: body,
    artifacts: (body.artifacts ?? []).map((artifact) => ({
      ...artifact,
      objectKey: objectKeyForArtifact(sessionId, artifact.id, body),
      status: "pending" as const,
    })),
    finalized: false,
  };

  await writeJsonFile(sessionPath(options.storageDir, sessionId), session);
  return {
    sessionId,
    buildId,
    expiresAt,
    uploadTargets: session.artifacts.map((artifact) => ({
      artifactId: artifact.id,
      method: "PUT" as const,
      url: `${options.publicUrl}/v1/upload-sessions/${sessionId}/artifacts/${encodeURIComponent(artifact.id)}`,
      headers: { "content-type": artifact.contentType },
      objectKey: artifact.objectKey,
      expiresAt,
    })),
  };
}

async function putArtifact(req: IncomingMessage, storageDir: string, artifactStore: ArtifactStore, sessionId: string, artifactId: string): Promise<void> {
  const session = await readJsonFile<StoredSession>(sessionPath(storageDir, sessionId));
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    throw new HttpError(410, "Upload session expired.");
  }
  const artifact = session.artifacts.find((item) => item.id === artifactId);
  if (!artifact) {
    throw new HttpError(404, "Artifact is not part of this upload session.");
  }

  const stored = await artifactStore.putArtifact(artifact.objectKey, await readBody(req));
  artifact.status = "uploaded";
  artifact.actualSha256 = stored.sha256;
  artifact.actualByteSize = stored.byteSize;
  artifact.uploadedAt = new Date().toISOString();
  artifact.verificationError = undefined;
  await writeJsonFile(sessionPath(storageDir, sessionId), session);
}

async function finalizeUploadSession(
  sessionId: string,
  body: FinalizeUploadSessionRequest,
  options: Required<Pick<ApiServerOptions, "storageDir" | "publicUrl" | "githubStore">> & ApiServerOptions,
): Promise<FinalizeUploadSessionResponse> {
  const session = await readJsonFile<StoredSession>(sessionPath(options.storageDir, sessionId));
  if (session.finalized) {
    return { buildId: session.buildId, status: "accepted", reportUrl: `${options.publicUrl}/v1/builds/${session.buildId}` };
  }
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    throw new HttpError(410, "Upload session expired.");
  }

  assertValidManifest(body.manifest);
  if (body.manifest.repository.fullName !== session.request.repository.fullName) {
    throw new HttpError(400, "Manifest repository does not match upload session.");
  }
  if (body.manifest.git.commitSha !== session.request.git.commitSha) {
    throw new HttpError(400, "Manifest commit SHA does not match upload session.");
  }

  const integrity = await verifyUploadIntegrity(session, body.manifest, options.artifactStore!);
  await writeJsonFile(sessionPath(options.storageDir, sessionId), session);
  if (!integrity.ok) {
    throw new HttpError(400, `Artifact integrity check failed:\n${integrity.errors.map((error) => `- ${error}`).join("\n")}`);
  }

  const buildDir = resolve(options.storageDir, "builds", session.buildId);
  await mkdir(buildDir, { recursive: true });
  await writeJsonFile(resolve(buildDir, "manifest.json"), body.manifest);
  const buildRecord: StoredBuildRecord = {
    buildId: session.buildId,
    sessionId,
    repository: body.manifest.repository,
    git: body.manifest.git,
    project: body.manifest.project,
    status: "queued",
    createdAt: session.createdAt,
    finalizedAt: new Date().toISOString(),
  };
  await writeJsonFile(resolve(buildDir, "build.json"), buildRecord);
  await writeJsonFile(resolve(options.storageDir, "queue", `${session.buildId}.json`), {
    id: session.buildId,
    type: "diff-build",
    buildId: session.buildId,
    payloadJson: JSON.stringify({ manifestPath: resolve(buildDir, "manifest.json") }),
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
  });

  await publishGitHubCheckRun(buildRecord, undefined, options);

  session.finalized = true;
  await writeJsonFile(sessionPath(options.storageDir, sessionId), session);

  return { buildId: session.buildId, status: "queued", reportUrl: `${options.publicUrl}/v1/builds/${session.buildId}` };
}

async function markBuildCompared(
  options: Required<Pick<ApiServerOptions, "storageDir" | "publicUrl" | "githubStore">> & ApiServerOptions,
  build: StoredBuildRecord,
  report: ComparisonReport,
): Promise<void> {
  const updated: StoredBuildRecord = {
    ...build,
    status: report.checkConclusion === "failure" ? "failed" : "completed",
    comparedAt: report.generatedAt,
    checkConclusion: strictCheckConclusionForReport(report),
    summary: report.summary,
  };
  await writeJsonFile(buildRecordPath(options.storageDir, report.buildId), updated);
  await publishGitHubCheckRun(updated, report, options);
}

async function publishGitHubCheckRun(
  build: StoredBuildRecord,
  report: ComparisonReport | undefined,
  options: Required<Pick<ApiServerOptions, "publicUrl" | "githubStore">> & ApiServerOptions,
): Promise<GitHubCheckRunRecord> {
  const now = new Date().toISOString();
  const existing = await options.githubStore.getCheckRunByBuildId(build.buildId);
  const installationId = numberFromString(build.repository.installationId);
  const request: GitHubCheckRunRequest = report
    ? {
        name: existing?.name ?? options.githubCheckName ?? DEFAULT_GITHUB_CHECK_NAME,
        headSha: build.git.commitSha,
        status: "completed",
        conclusion: strictCheckConclusionForReport(report),
        detailsUrl: `${options.publicUrl}/v1/builds/${build.buildId}`,
        output: checkOutputForComparisonReport(report),
      }
    : {
        name: existing?.name ?? options.githubCheckName ?? DEFAULT_GITHUB_CHECK_NAME,
        headSha: build.git.commitSha,
        status: "queued",
        detailsUrl: `${options.publicUrl}/v1/builds/${build.buildId}`,
        output: checkOutputForQueuedBuild(),
      };

  let githubCheckRunId = existing?.githubCheckRunId;
  if (options.githubCheckPublisher && installationId !== undefined) {
    if (githubCheckRunId !== undefined) {
      await options.githubCheckPublisher.updateCheckRun({
        installationId,
        repositoryFullName: build.repository.fullName,
        githubCheckRunId,
        request,
      });
    } else {
      const created = await options.githubCheckPublisher.createCheckRun({
        installationId,
        repositoryFullName: build.repository.fullName,
        request,
      });
      githubCheckRunId = created.githubCheckRunId;
    }
  }

  const record: GitHubCheckRunRecord = {
    buildId: build.buildId,
    repositoryFullName: build.repository.fullName,
    headSha: build.git.commitSha,
    installationId,
    githubCheckRunId,
    name: request.name,
    status: request.status,
    conclusion: request.conclusion,
    detailsUrl: request.detailsUrl,
    output: request.output,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await options.githubStore.saveCheckRun(record);
  return record;
}

async function handleGitHubWebhook(
  req: IncomingMessage,
  payloadBytes: Buffer,
  options: Required<Pick<ApiServerOptions, "githubStore">> & ApiServerOptions,
): Promise<{ accepted: true; duplicate?: true; event: string; deliveryId: string }> {
  const deliveryId = stringHeader(req.headers["x-github-delivery"]);
  const event = stringHeader(req.headers["x-github-event"]);
  if (!deliveryId || !event) {
    throw new HttpError(400, "GitHub webhook requires x-github-delivery and x-github-event headers.");
  }

  const secret = options.githubWebhookSecret ?? process.env.CHROMA_SNAP_GITHUB_WEBHOOK_SECRET;
  if (secret) {
    const signature = stringHeader(req.headers["x-hub-signature-256"]);
    if (!verifyGitHubWebhookSignature(secret, payloadBytes, signature)) {
      throw new HttpError(401, "Invalid GitHub webhook signature.");
    }
  } else if (!options.allowDevAuth && process.env.CHROMA_SNAP_DEV_AUTH !== "1") {
    throw new HttpError(401, "GitHub webhook signature verification requires CHROMA_SNAP_GITHUB_WEBHOOK_SECRET.");
  }

  const existing = await options.githubStore.getWebhookEvent(deliveryId);
  if (existing?.processed) {
    return { accepted: true, duplicate: true, event, deliveryId };
  }

  const payload = JSON.parse(payloadBytes.toString("utf8")) as Record<string, unknown>;
  await options.githubStore.saveWebhookEvent(webhookRecordFromPayload({ deliveryId, event, payload, processed: false }));
  await processGitHubWebhookEvent(event, payload, options.githubStore, new Date().toISOString());
  await options.githubStore.markWebhookEventProcessed(deliveryId, new Date().toISOString());
  return { accepted: true, event, deliveryId };
}

async function processGitHubWebhookEvent(event: string, payload: Record<string, unknown>, store: GitHubIntegrationStore, now: string): Promise<void> {
  switch (event) {
    case "installation":
      await processInstallationWebhook(payload, store, now);
      return;
    case "installation_repositories":
      await processInstallationRepositoriesWebhook(payload, store, now);
      return;
    case "pull_request":
      await processPullRequestWebhook(payload, store, now);
      return;
    case "push":
      await processPushWebhook(payload, store, now);
      return;
    default:
      return;
  }
}

async function processInstallationWebhook(payload: Record<string, unknown>, store: GitHubIntegrationStore, now: string): Promise<void> {
  const installation = objectValue(payload.installation);
  const installationId = numberValue(installation.id);
  if (installationId === undefined) {
    return;
  }
  if (payload.action === "deleted") {
    await store.deleteInstallation(installationId, now);
    return;
  }

  const existing = await store.getInstallation(installationId);
  const repositories = arrayValue(payload.repositories).map(repositoryDescriptor).filter(isDefined);
  const record: GitHubInstallationRecord = {
    installationId,
    appId: numberValue(installation.app_id),
    accountLogin: stringValue(objectValue(installation.account).login),
    permissions: recordValue(installation.permissions),
    repositories: repositories.length > 0 ? repositories : existing?.repositories ?? [],
    suspendedAt: stringValue(installation.suspended_at),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await store.saveInstallation(record);
}

async function processInstallationRepositoriesWebhook(payload: Record<string, unknown>, store: GitHubIntegrationStore, now: string): Promise<void> {
  const installation = objectValue(payload.installation);
  const installationId = numberValue(installation.id);
  if (installationId === undefined) {
    return;
  }
  const existing = await store.getInstallation(installationId);
  const added = arrayValue(payload.repositories_added).map(repositoryDescriptor).filter(isDefined);
  const removed = new Set(arrayValue(payload.repositories_removed).map((repository) => repositoryDescriptor(repository)?.fullName).filter(isDefined));
  const repositories = mergeRepositories(existing?.repositories ?? [], added).filter((repository) => !removed.has(repository.fullName));
  await store.saveInstallation({
    installationId,
    appId: existing?.appId ?? numberValue(installation.app_id),
    accountLogin: existing?.accountLogin ?? stringValue(objectValue(installation.account).login),
    permissions: existing?.permissions ?? recordValue(installation.permissions),
    repositories,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

async function processPullRequestWebhook(payload: Record<string, unknown>, store: GitHubIntegrationStore, now: string): Promise<void> {
  const repository = repositoryDescriptor(payload.repository);
  const pullRequest = objectValue(payload.pull_request);
  const number = numberValue(pullRequest.number);
  if (!repository || number === undefined) {
    return;
  }
  const record: GitHubPullRequestRecord = {
    repositoryFullName: repository.fullName,
    number,
    action: stringValue(payload.action) ?? "unknown",
    title: stringValue(pullRequest.title),
    state: stringValue(pullRequest.state),
    merged: booleanValue(pullRequest.merged),
    headRef: stringValue(objectValue(pullRequest.head).ref) ?? "",
    headSha: stringValue(objectValue(pullRequest.head).sha) ?? "",
    baseRef: stringValue(objectValue(pullRequest.base).ref) ?? "",
    baseSha: stringValue(objectValue(pullRequest.base).sha),
    mergeCommitSha: stringValue(pullRequest.merge_commit_sha) ?? null,
    senderLogin: stringValue(objectValue(payload.sender).login),
    installationId: numberValue(objectValue(payload.installation).id),
    updatedAt: now,
  };
  await store.savePullRequest(record);
}

async function processPushWebhook(payload: Record<string, unknown>, store: GitHubIntegrationStore, now: string): Promise<void> {
  const repository = repositoryDescriptor(payload.repository);
  const ref = stringValue(payload.ref);
  const sha = stringValue(payload.after);
  if (!repository || !ref || !sha) {
    return;
  }
  const record: GitHubRefRecord = {
    repositoryFullName: repository.fullName,
    ref,
    sha,
    before: stringValue(payload.before),
    pusher: stringValue(objectValue(payload.pusher).name) ?? stringValue(objectValue(payload.sender).login),
    installationId: numberValue(objectValue(payload.installation).id),
    updatedAt: now,
  };
  await store.saveRef(record);
}

function webhookRecordFromPayload(input: {
  deliveryId: string;
  event: string;
  payload: Record<string, unknown>;
  processed: boolean;
}): GitHubWebhookEventRecord {
  return {
    deliveryId: input.deliveryId,
    event: input.event,
    action: stringValue(input.payload.action),
    processed: input.processed,
    receivedAt: new Date().toISOString(),
    repositoryFullName: repositoryDescriptor(input.payload.repository)?.fullName,
    installationId: numberValue(objectValue(input.payload.installation).id),
    payload: input.payload,
  };
}

function repositoryDescriptor(value: unknown): GitHubRepositoryDescriptor | undefined {
  const repository = objectValue(value);
  const fullName = stringValue(repository.full_name) ?? stringValue(repository.fullName);
  const name = stringValue(repository.name);
  const owner = stringValue(objectValue(repository.owner).login) ?? fullName?.split("/")[0];
  if (!fullName || !name || !owner) {
    return undefined;
  }
  return { id: numberValue(repository.id), owner, name, fullName, private: booleanValue(repository.private) };
}

function mergeRepositories(existing: GitHubRepositoryDescriptor[], added: GitHubRepositoryDescriptor[]): GitHubRepositoryDescriptor[] {
  const byName = new Map(existing.map((repository) => [repository.fullName, repository]));
  for (const repository of added) {
    byName.set(repository.fullName, repository);
  }
  return [...byName.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function numberFromString(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordValue(value: unknown): Record<string, string> {
  const record = objectValue(value);
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

async function assertUploadAuth(req: IncomingMessage, options: ApiServerOptions): Promise<void> {
  if (options.allowDevAuth || process.env.CHROMA_SNAP_DEV_AUTH === "1") {
    return;
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    throw new HttpError(401, "Upload requires a GitHub Actions OIDC bearer token or CHROMA_SNAP_DEV_AUTH=1 for local development.");
  }

  const token = auth.slice("Bearer ".length);
  const claims = decodeJwtPayloadWithoutVerifying(token);
  const validation = validateGitHubActionsOidcClaims(claims, { audience: options.oidcAudience });
  if (!validation.ok) {
    throw new HttpError(401, validation.errors.join(" "));
  }

  // Production hosted deployment must verify the JWT signature against the GitHub Actions JWKS
  // and verify GitHub App installation access before reaching this point.
  if (process.env.CHROMA_SNAP_ALLOW_UNSIGNED_OIDC !== "1") {
    throw new HttpError(501, "OIDC claim parsing is present, but signature verification is not enabled in this local MVP. Set CHROMA_SNAP_ALLOW_UNSIGNED_OIDC=1 only for local testing.");
  }
}

function sessionPath(storageDir: string, sessionId: string): string {
  return resolve(storageDir, "sessions", `${sessionId}.json`);
}

function buildRecordPath(storageDir: string, buildId: string): string {
  return resolve(storageDir, "builds", buildId, "build.json");
}

async function readBuildRecord(storageDir: string, buildId: string): Promise<StoredBuildRecord> {
  try {
    return await readJsonFile<StoredBuildRecord>(buildRecordPath(storageDir, buildId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(404, "Build not found.");
    }
    throw error;
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  return JSON.parse((await readBody(req)).toString("utf8")) as T;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readJsonFile<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
