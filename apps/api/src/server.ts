import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  applyReviewDecisionsToReport,
  assertValidManifest,
  assertWithinPrivateBetaLimits,
  ChromaSnapError,
  checkOutputForComparisonReport,
  checkOutputForQueuedBuild,
  createMetricEvent,
  DEFAULT_PRIVATE_BETA_LIMITS,
  DEFAULT_RETENTION_POLICY,
  createSignedArtifactUrl,
  DEFAULT_GITHUB_CHECK_NAME,
  FileArtifactStore,
  FileBaselineStore,
  FileComparisonStore,
  FileReviewStore,
  errorCodeForHttpStatus,
  evaluateBuildManifestLimits,
  evaluateUploadSessionLimits,
  isReviewableRepositoryPermission,
  metricJsonLine,
  planRetentionSweep,
  serializeChromaSnapError,
  summarizeManifestUsage,
  strictCheckConclusionForReport,
  verifyArtifactSignature,
  type ArtifactStore,
  type AuditEvent,
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
  type MetricEvent,
  type MetricSink,
  type PrivateBetaLimits,
  type RepositoryPermission,
  type RetentionCandidate,
  type RetentionPolicy,
  type ReviewDecision,
  type ReviewDecisionRequest,
  type ReviewStore,
  type ReviewableRepositoryPermission,
  type SnapshotComparison,
  type UploadSessionResponse,
} from "@chroma-snap/shared";
import { type GitHubCheckPublisher, verifyGitHubWebhookSignature } from "./github-app.js";
import { FileGitHubIntegrationStore, type GitHubIntegrationStore } from "./github-store.js";
import { decodeJwtPayloadWithoutVerifying, validateGitHubActionsOidcClaims } from "./oidc.js";
import { objectKeyForArtifact, type StoredSession } from "./session.js";
import { verifyUploadIntegrity } from "./upload-integrity.js";

export interface GitHubPermissionVerifier {
  getRepositoryPermission(input: {
    repositoryFullName: string;
    login: string;
    accessToken?: string;
    installationId?: number;
  }): Promise<RepositoryPermission | undefined>;
}

export interface ApiRequestLogEvent {
  kind: "request";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  timestamp: string;
}

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
  reviewStore?: ReviewStore;
  githubStore?: GitHubIntegrationStore;
  githubCheckPublisher?: GitHubCheckPublisher;
  githubWebhookSecret?: string;
  githubCheckName?: string;
  githubPermissionVerifier?: GitHubPermissionVerifier;
  artifactSigningSecret?: string;
  signedArtifactUrlTtlSeconds?: number;
  adminSecret?: string;
  privateBetaLimits?: PrivateBetaLimits | false;
  retentionPolicy?: RetentionPolicy;
  metricsSink?: MetricSink;
  requestLogSink?: (event: ApiRequestLogEvent) => void | Promise<void>;
  enableRequestLogging?: boolean;
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

type ApiRuntimeOptions = Required<Pick<ApiServerOptions, "host" | "port" | "storageDir" | "publicUrl" | "artifactStore" | "baselineStore" | "comparisonStore" | "reviewStore" | "githubStore">> & ApiServerOptions & { requestId?: string; serverStartedAt?: Date };

export async function startApiServer(options: ApiServerOptions = {}): Promise<{ server: Server; url: string }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4007;
  const storageDir = resolve(options.storageDir ?? ".chroma-snap/server");
  const artifactStore = options.artifactStore ?? new FileArtifactStore(storageDir);
  const baselineStore = options.baselineStore ?? new FileBaselineStore(resolve(storageDir, "baselines.json"));
  const comparisonStore = options.comparisonStore ?? new FileComparisonStore(resolve(storageDir, "comparisons.json"));
  const reviewStore = options.reviewStore ?? new FileReviewStore(resolve(storageDir, "reviews.json"));
  const githubStore = options.githubStore ?? new FileGitHubIntegrationStore(storageDir);
  const serverStartedAt = new Date();
  let publicUrl = options.publicUrl ?? `http://${host}:${port}`;
  await mkdir(storageDir, { recursive: true });

  const server = createServer(async (req, res) => {
    const requestId = requestIdFor(req);
    const requestStarted = performance.now();
    res.setHeader("x-request-id", requestId);
    try {
      await route(req, res, { ...options, host, port, storageDir, publicUrl, artifactStore, baselineStore, comparisonStore, reviewStore, githubStore, requestId, serverStartedAt });
    } catch (error) {
      const response = serializeChromaSnapError(error, requestId);
      sendJson(res, response.status, response);
    } finally {
      const durationMs = Math.round((performance.now() - requestStarted) * 1000) / 1000;
      await emitApiMetric(options, createMetricEvent({
        name: "api.request",
        value: durationMs,
        unit: "milliseconds",
        labels: { method: req.method ?? "", path: safeRequestPath(req, publicUrl), status: res.statusCode, requestId },
      }));
      await emitRequestLog(options, {
        kind: "request",
        requestId,
        method: req.method ?? "",
        path: safeRequestPath(req, publicUrl),
        status: res.statusCode,
        durationMs,
        timestamp: new Date().toISOString(),
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
  options: ApiRuntimeOptions & { requestId: string; serverStartedAt: Date },
): Promise<void> {
  const url = new URL(req.url ?? "/", options.publicUrl);

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
    sendJson(res, 200, healthResponse(options));
    return;
  }

  if (req.method === "GET" && (url.pathname === "/ready" || url.pathname === "/readyz")) {
    await stat(options.storageDir);
    sendJson(res, 200, { ...healthResponse(options), ready: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/admin/diagnostics") {
    await assertAdminAccess(req, options);
    sendJson(res, 200, await readDiagnostics(options));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/admin/cleanup") {
    await assertAdminAccess(req, options);
    const cleanup = await runRetentionCleanup(url, options);
    await emitApiMetric(options, createMetricEvent({
      name: "cleanup.completed",
      value: cleanup.deleted.total,
      labels: { dryRun: cleanup.dryRun, requestId: options.requestId },
    }));
    sendJson(res, 200, cleanup);
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/artifacts") {
    await sendSignedArtifact(req, res, url, options);
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/reports") {
    const limit = parsePositiveInteger(url.searchParams.get("limit"));
    const reports = options.comparisonStore.listComparisonReports ? await options.comparisonStore.listComparisonReports({ limit }) : [];
    const reviewedReports = await Promise.all(
      reports.map(async (report) => applyReviewDecisionsToReport(report, await options.reviewStore.listReviewDecisions({ buildId: report.buildId }))),
    );
    sendJson(res, 200, { reports: reviewedReports });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/review-decisions") {
    const decisions = await options.reviewStore.listReviewDecisions({
      buildId: url.searchParams.get("buildId") ?? undefined,
      identityKey: url.searchParams.get("identityKey") ?? undefined,
      state: reviewDecisionState(url.searchParams.get("state")),
    });
    sendJson(res, 200, { decisions });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/audit-events") {
    const events = await options.reviewStore.listAuditEvents({
      repositoryFullName: url.searchParams.get("repositoryFullName") ?? undefined,
      buildId: url.searchParams.get("buildId") ?? undefined,
      identityKey: url.searchParams.get("identityKey") ?? undefined,
      eventType: url.searchParams.get("eventType") ?? undefined,
      limit: parsePositiveInteger(url.searchParams.get("limit")),
    });
    sendJson(res, 200, { auditEvents: events });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/audit-events") {
    await assertUploadAuth(req, options);
    const body = await readJson<{ event?: AuditEvent }>(req);
    if (!body.event) {
      throw new HttpError(400, "event is required.");
    }
    const event: AuditEvent = { ...body.event, id: randomUUID(), createdAt: new Date().toISOString() };
    await options.reviewStore.saveAuditEvent(event);
    sendJson(res, 201, { event });
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
    const decisions = await options.reviewStore.listReviewDecisions({ buildId: body.report.buildId });
    await markBuildCompared(options, build, applyReviewDecisionsToReport(body.report, decisions));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (comparisonMatch && req.method === "GET") {
    const buildId = comparisonMatch[1]!;
    const report = await options.comparisonStore.getComparisonReport(buildId);
    if (!report) {
      throw new HttpError(404, "Comparison report not found.");
    }
    const decisions = await options.reviewStore.listReviewDecisions({ buildId });
    sendJson(res, 200, { report: applyReviewDecisionsToReport(report, decisions), decisions });
    return;
  }

  const reviewMatch = url.pathname.match(/^\/v1\/builds\/([^/]+)\/review$/);
  if (reviewMatch && req.method === "GET") {
    const buildId = reviewMatch[1]!;
    const build = await readBuildRecord(options.storageDir, buildId);
    const report = await options.comparisonStore.getComparisonReport(buildId);
    if (!report) {
      throw new HttpError(404, "Comparison report not found.");
    }
    const decisions = await options.reviewStore.listReviewDecisions({ buildId });
    const reviewedReport = applyReviewDecisionsToReport(report, decisions);
    const auditEvents = await options.reviewStore.listAuditEvents({ repositoryFullName: build.repository.fullName, buildId });
    sendJson(res, 200, {
      build,
      report: reviewedReport,
      decisions,
      auditEvents,
      artifactUrls: signedArtifactUrlsForReport(reviewedReport, options, buildId),
    });
    return;
  }

  const decisionMatch = url.pathname.match(/^\/v1\/builds\/([^/]+)\/decisions$/);
  if (decisionMatch && req.method === "GET") {
    const buildId = decisionMatch[1]!;
    await readBuildRecord(options.storageDir, buildId);
    const identityKey = url.searchParams.get("identityKey") ?? undefined;
    const decisions = await options.reviewStore.listReviewDecisions({ buildId, identityKey });
    sendJson(res, 200, { decisions });
    return;
  }

  if (decisionMatch && req.method === "POST") {
    const buildId = decisionMatch[1]!;
    const payload = await readJsonOrForm<ReviewDecisionRequest & ReviewDecisionFormFields>(req);
    const decision = await createReviewDecision(buildId, payload, req, options);
    if (isFormRequest(req)) {
      res.statusCode = 303;
      res.setHeader("location", req.headers.referer ?? `${options.publicUrl}/v1/builds/${buildId}/review`);
      res.end();
      return;
    }
    sendJson(res, 201, { decision });
    return;
  }

  const auditMatch = url.pathname.match(/^\/v1\/builds\/([^/]+)\/audit-events$/);
  if (auditMatch && req.method === "GET") {
    const build = await readBuildRecord(options.storageDir, auditMatch[1]!);
    const events = await options.reviewStore.listAuditEvents({ repositoryFullName: build.repository.fullName, buildId: build.buildId, limit: parsePositiveInteger(url.searchParams.get("limit")) });
    sendJson(res, 200, { auditEvents: events });
    return;
  }

  const artifactUrlMatch = url.pathname.match(/^\/v1\/builds\/([^/]+)\/artifact-url$/);
  if (artifactUrlMatch && req.method === "GET") {
    const buildId = artifactUrlMatch[1]!;
    const objectKey = url.searchParams.get("objectKey") ?? undefined;
    if (!objectKey) {
      throw new HttpError(400, "objectKey is required.");
    }
    const build = await readBuildRecord(options.storageDir, buildId);
    const report = await options.comparisonStore.getComparisonReport(buildId);
    if (!report) {
      throw new HttpError(404, "Comparison report not found.");
    }
    if (!artifactObjectKeysForReport(report).has(objectKey)) {
      throw new HttpError(404, "Artifact is not referenced by this build report.");
    }
    await assertArtifactReadAccess(req, build, options);
    const expiresAt = new Date(Date.now() + signedArtifactTtlMs(options)).toISOString();
    const signedUrl = createSignedArtifactUrl({ publicUrl: options.publicUrl, objectKey, buildId, expiresAt, secret: artifactSigningSecret(options) });
    sendJson(res, 200, { url: signedUrl, expiresAt });
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

interface AdminDiagnostics {
  ok: true;
  service: "chroma-snap-api";
  storageDir: string;
  startedAt?: string;
  uptimeSeconds?: number;
  counts: {
    sessions: number;
    builds: number;
    queueJobs: number;
    comparisonReports: number;
    auditEvents: number;
  };
  storage: {
    artifactBytes: number;
  };
}

interface CleanupSummary {
  scanned: number;
  deleted: number;
  protected: number;
  freedBytes: number;
}

interface CleanupResult {
  ok: true;
  dryRun: boolean;
  before?: string;
  kinds: string[];
  deleted: CleanupSummary & { total: number };
  artifacts: CleanupSummary & { objectKeys: string[] };
  uploadSessions: CleanupSummary & { sessionIds: string[] };
  comparisons: CleanupSummary & { buildIds: string[] };
  queueJobs: CleanupSummary & { jobIds: string[] };
  warnings: string[];
}

function healthResponse(options: ApiRuntimeOptions): { ok: true; service: "chroma-snap-api"; startedAt?: string; uptimeSeconds?: number } {
  const startedAt = options.serverStartedAt?.toISOString();
  const uptimeSeconds = options.serverStartedAt ? Math.round((Date.now() - options.serverStartedAt.getTime()) / 1000) : undefined;
  return { ok: true, service: "chroma-snap-api", startedAt, uptimeSeconds };
}

async function readDiagnostics(options: ApiRuntimeOptions): Promise<AdminDiagnostics> {
  const [sessions, builds, queueJobs, reports, auditEvents, artifactBytes] = await Promise.all([
    countJsonFiles(resolve(options.storageDir, "sessions")),
    countDirectories(resolve(options.storageDir, "builds")),
    countJsonFiles(resolve(options.storageDir, "queue")),
    options.comparisonStore.listComparisonReports ? options.comparisonStore.listComparisonReports().then((items) => items.length) : Promise.resolve(0),
    options.reviewStore.listAuditEvents({}).then((items) => items.length),
    directoryByteSize(resolve(options.storageDir, "artifacts")),
  ]);
  return {
    ...healthResponse(options),
    storageDir: options.storageDir,
    counts: { sessions, builds, queueJobs, comparisonReports: reports, auditEvents },
    storage: { artifactBytes },
  };
}

async function runRetentionCleanup(url: URL, options: ApiRuntimeOptions): Promise<CleanupResult> {
  const dryRun = parseBoolean(url.searchParams.get("dryRun")) ?? false;
  const before = parseOptionalDate(url.searchParams.get("before"));
  const limit = parsePositiveInteger(url.searchParams.get("limit")) ?? 1_000;
  const kinds = cleanupKinds(url);
  const result = emptyCleanupResult(dryRun, before, [...kinds]);

  if (kinds.has("artifact")) {
    const artifactResult = await cleanupAbandonedUploadSessions({ options, dryRun, before, limit });
    mergeCleanupSummary(result.artifacts, artifactResult.artifacts);
    mergeCleanupSummary(result.uploadSessions, artifactResult.uploadSessions);
    result.artifacts.objectKeys.push(...artifactResult.artifacts.objectKeys);
    result.uploadSessions.sessionIds.push(...artifactResult.uploadSessions.sessionIds);
    result.warnings.push(...artifactResult.warnings);
  }

  if (kinds.has("comparison")) {
    const comparisonResult = await cleanupComparisonReports({ options, dryRun, before, limit });
    mergeCleanupSummary(result.comparisons, comparisonResult.comparisons);
    result.comparisons.buildIds.push(...comparisonResult.comparisons.buildIds);
    result.warnings.push(...comparisonResult.warnings);
  }

  if (kinds.has("queue-job")) {
    const queueResult = await cleanupQueueJobs({ options, dryRun, before, limit });
    mergeCleanupSummary(result.queueJobs, queueResult.queueJobs);
    result.queueJobs.jobIds.push(...queueResult.queueJobs.jobIds);
    result.warnings.push(...queueResult.warnings);
  }

  result.deleted.scanned = result.artifacts.scanned + result.uploadSessions.scanned + result.comparisons.scanned + result.queueJobs.scanned;
  result.deleted.deleted = result.artifacts.deleted + result.uploadSessions.deleted + result.comparisons.deleted + result.queueJobs.deleted;
  result.deleted.protected = result.artifacts.protected + result.uploadSessions.protected + result.comparisons.protected + result.queueJobs.protected;
  result.deleted.freedBytes = result.artifacts.freedBytes + result.uploadSessions.freedBytes + result.comparisons.freedBytes + result.queueJobs.freedBytes;
  result.deleted.total = result.deleted.deleted;
  return result;
}

async function cleanupAbandonedUploadSessions(input: { options: ApiRuntimeOptions; dryRun: boolean; before?: Date; limit: number }): Promise<Pick<CleanupResult, "artifacts" | "uploadSessions" | "warnings">> {
  const artifacts = emptyArtifactCleanupSummary();
  const uploadSessions = emptySessionCleanupSummary();
  const warnings: string[] = [];
  const sessionFiles = await listJsonFiles(resolve(input.options.storageDir, "sessions"));
  const candidates: Array<RetentionCandidate & { session: StoredSession; path: string }> = [];
  const now = input.before ?? new Date();

  for (const path of sessionFiles) {
    const session = await readJsonFile<StoredSession>(path);
    const expiredByUploadWindow = Date.parse(session.expiresAt) < now.getTime();
    const protectedSession = session.finalized || !expiredByUploadWindow;
    candidates.push({ id: session.sessionId, kind: "artifact", createdAt: session.createdAt, protected: protectedSession, session, path });
  }

  const expired = expiredRetentionCandidates(candidates, input.options.retentionPolicy, input.before).slice(0, input.limit);
  uploadSessions.scanned = candidates.length;
  uploadSessions.protected = candidates.length - expired.length;

  for (const candidate of expired) {
    const uploadedKeys = candidate.session.artifacts.filter((artifact) => artifact.status === "uploaded").map((artifact) => artifact.objectKey);
    for (const objectKey of uploadedKeys) {
      const verification = await input.options.artifactStore.verifyArtifact(objectKey);
      artifacts.scanned += 1;
      if (verification.byteSize) {
        artifacts.freedBytes += verification.byteSize;
      }
    }
    if (!input.dryRun) {
      await input.options.artifactStore.deleteArtifacts(uploadedKeys);
      await rm(candidate.path, { force: true });
    }
    artifacts.deleted += uploadedKeys.length;
    artifacts.objectKeys.push(...uploadedKeys);
    uploadSessions.deleted += 1;
    uploadSessions.sessionIds.push(candidate.session.sessionId);
  }

  return { artifacts, uploadSessions, warnings };
}

async function cleanupComparisonReports(input: { options: ApiRuntimeOptions; dryRun: boolean; before?: Date; limit: number }): Promise<Pick<CleanupResult, "comparisons" | "warnings">> {
  const comparisons = emptyComparisonCleanupSummary();
  const warnings: string[] = [];
  if (!input.options.comparisonStore.listComparisonReports) {
    warnings.push("Comparison cleanup skipped because the configured comparison store cannot list reports.");
    return { comparisons, warnings };
  }
  const reports = await input.options.comparisonStore.listComparisonReports();
  const candidates = reports.map((report): RetentionCandidate & { buildId: string } => ({
    id: report.buildId,
    buildId: report.buildId,
    kind: "comparison",
    createdAt: report.generatedAt,
  }));
  const expired = expiredRetentionCandidates(candidates, input.options.retentionPolicy, input.before).slice(0, input.limit);
  comparisons.scanned = candidates.length;
  comparisons.protected = candidates.length - expired.length;
  comparisons.deleted = expired.length;
  comparisons.buildIds.push(...expired.map((candidate) => candidate.buildId));
  if (expired.length > 0 && !input.dryRun) {
    if (!input.options.comparisonStore.deleteComparisonReports) {
      warnings.push("Comparison cleanup planned expired reports, but the configured comparison store cannot delete reports.");
      comparisons.deleted = 0;
      comparisons.protected = candidates.length;
    } else {
      await input.options.comparisonStore.deleteComparisonReports(expired.map((candidate) => candidate.buildId));
    }
  }
  return { comparisons, warnings };
}

async function cleanupQueueJobs(input: { options: ApiRuntimeOptions; dryRun: boolean; before?: Date; limit: number }): Promise<Pick<CleanupResult, "queueJobs" | "warnings">> {
  const queueJobs = emptyQueueCleanupSummary();
  const warnings: string[] = [];
  const queueFiles = await listJsonFiles(resolve(input.options.storageDir, "queue"));
  const candidates: Array<RetentionCandidate & { path: string; jobId: string }> = [];
  for (const path of queueFiles) {
    const job = await readJsonFile<{ id: string; status?: string; createdAt: string; processedAt?: string }>(path);
    candidates.push({
      id: job.id,
      jobId: job.id,
      path,
      kind: "queue-job",
      createdAt: job.processedAt ?? job.createdAt,
      protected: job.status !== "completed" && job.status !== "failed",
    });
  }
  const expired = expiredRetentionCandidates(candidates, input.options.retentionPolicy, input.before).slice(0, input.limit);
  queueJobs.scanned = candidates.length;
  queueJobs.protected = candidates.length - expired.length;
  queueJobs.deleted = expired.length;
  queueJobs.jobIds.push(...expired.map((candidate) => candidate.jobId));
  if (!input.dryRun) {
    await Promise.all(expired.map((candidate) => rm(candidate.path, { force: true })));
  }
  return { queueJobs, warnings };
}

function emptyCleanupResult(dryRun: boolean, before: Date | undefined, kinds: string[]): CleanupResult {
  return {
    ok: true,
    dryRun,
    before: before?.toISOString(),
    kinds,
    deleted: { ...emptySummaryCleanup(), total: 0 },
    artifacts: emptyArtifactCleanupSummary(),
    uploadSessions: emptySessionCleanupSummary(),
    comparisons: emptyComparisonCleanupSummary(),
    queueJobs: emptyQueueCleanupSummary(),
    warnings: [],
  };
}

function emptySummaryCleanup(): CleanupSummary {
  return { scanned: 0, deleted: 0, protected: 0, freedBytes: 0 };
}

function emptyArtifactCleanupSummary(): CleanupSummary & { objectKeys: string[] } {
  return { ...emptySummaryCleanup(), objectKeys: [] };
}

function emptySessionCleanupSummary(): CleanupSummary & { sessionIds: string[] } {
  return { ...emptySummaryCleanup(), sessionIds: [] };
}

function emptyComparisonCleanupSummary(): CleanupSummary & { buildIds: string[] } {
  return { ...emptySummaryCleanup(), buildIds: [] };
}

function emptyQueueCleanupSummary(): CleanupSummary & { jobIds: string[] } {
  return { ...emptySummaryCleanup(), jobIds: [] };
}

function mergeCleanupSummary(target: CleanupSummary, source: CleanupSummary): void {
  target.scanned += source.scanned;
  target.deleted += source.deleted;
  target.protected += source.protected;
  target.freedBytes += source.freedBytes;
}

function cleanupKinds(url: URL): Set<"artifact" | "comparison" | "queue-job"> {
  const rawKinds = url.searchParams.getAll("kind").flatMap((value) => value.split(",").map((item) => item.trim()).filter(Boolean));
  const kinds = rawKinds.length === 0 ? ["artifact", "comparison", "queue-job"] : rawKinds;
  const allowed = new Set(["artifact", "comparison", "queue-job"] as const);
  for (const kind of kinds) {
    if (!allowed.has(kind as "artifact" | "comparison" | "queue-job")) {
      throw new HttpError(400, `Unsupported cleanup kind '${kind}'.`);
    }
  }
  return new Set(kinds as Array<"artifact" | "comparison" | "queue-job">);
}

function expiredRetentionCandidates<T extends RetentionCandidate>(candidates: T[], policy: RetentionPolicy | undefined, before: Date | undefined): T[] {
  if (before) {
    return candidates.filter((candidate) => !candidate.protected && Date.parse(candidate.createdAt) < before.getTime());
  }
  const expired = new Set(planRetentionSweep(candidates, policy ?? DEFAULT_RETENTION_POLICY).expired.map((candidate) => candidate.id));
  return candidates.filter((candidate) => expired.has(candidate.id));
}

function privateBetaLimits(options: ApiServerOptions): PrivateBetaLimits {
  if (options.privateBetaLimits === false) {
    return {};
  }
  return { ...DEFAULT_PRIVATE_BETA_LIMITS, ...(options.privateBetaLimits ?? {}) };
}

function enforcePrivateBetaLimits(violations: ReturnType<typeof evaluateUploadSessionLimits> | ReturnType<typeof evaluateBuildManifestLimits>): void {
  assertWithinPrivateBetaLimits(violations);
}

async function assertAdminAccess(req: IncomingMessage, options: ApiServerOptions): Promise<void> {
  if (options.allowDevAuth || process.env.CHROMA_SNAP_DEV_AUTH === "1") {
    return;
  }
  const expected = options.adminSecret ?? process.env.CHROMA_SNAP_ADMIN_SECRET;
  if (!expected) {
    throw new HttpError(501, "Admin endpoints require CHROMA_SNAP_ADMIN_SECRET outside development auth.");
  }
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice("Bearer ".length) : undefined;
  const actual = stringHeader(req.headers["x-chroma-snap-admin-secret"]) ?? bearer;
  if (actual !== expected) {
    throw new HttpError(403, "Admin endpoint access denied.");
  }
}

async function countJsonFiles(dir: string): Promise<number> {
  return (await listJsonFiles(dir)).length;
}

async function countDirectories(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => resolve(dir, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function directoryByteSize(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const sizes = await Promise.all(entries.map(async (entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        return directoryByteSize(path);
      }
      if (entry.isFile()) {
        return (await stat(path)).size;
      }
      return 0;
    }));
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function createUploadSession(body: CreateUploadSessionRequest, options: Required<Pick<ApiServerOptions, "storageDir" | "publicUrl">> & ApiServerOptions): Promise<UploadSessionResponse> {
  if (!body.repository?.fullName || !body.git?.commitSha || !body.configHash) {
    throw new HttpError(400, "repository.fullName, git.commitSha, and configHash are required.");
  }

  if (options.privateBetaLimits !== false) {
    enforcePrivateBetaLimits(evaluateUploadSessionLimits(body, privateBetaLimits(options)));
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
  await emitApiMetric(options, createMetricEvent({
    name: "upload_session.created",
    value: 1,
    labels: {
      repository: body.repository.fullName,
      project: body.project.name,
      artifactCount: session.artifacts.length,
    },
  }));
  await emitApiMetric(options, createMetricEvent({
    name: "upload_session.declared_artifact_bytes",
    value: session.artifacts.reduce((sum, artifact) => sum + (artifact.byteSize ?? 0), 0),
    unit: "bytes",
    labels: { repository: body.repository.fullName, project: body.project.name },
  }));
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
    return { buildId: session.buildId, status: "accepted", reportUrl: `${options.publicUrl}/v1/builds/${session.buildId}/review` };
  }
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    throw new HttpError(410, "Upload session expired.");
  }

  assertValidManifest(body.manifest);
  if (options.privateBetaLimits !== false) {
    enforcePrivateBetaLimits(evaluateBuildManifestLimits(body.manifest, privateBetaLimits(options)));
  }

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

  const usage = summarizeManifestUsage(body.manifest);
  await emitApiMetric(options, createMetricEvent({
    name: "build.finalized",
    value: 1,
    labels: {
      repository: body.manifest.repository.fullName,
      project: body.manifest.project.name,
      branch: body.manifest.git.branch,
      snapshotCount: usage.snapshotCount,
      capturedSnapshotCount: usage.capturedSnapshotCount,
      erroredSnapshotCount: usage.erroredSnapshotCount,
    },
  }));
  await emitApiMetric(options, createMetricEvent({
    name: "build.snapshot_artifact_bytes",
    value: usage.artifactBytes,
    unit: "bytes",
    labels: { repository: body.manifest.repository.fullName, project: body.manifest.project.name },
  }));

  return { buildId: session.buildId, status: "queued", reportUrl: `${options.publicUrl}/v1/builds/${session.buildId}/review` };
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
        detailsUrl: `${options.publicUrl}/v1/builds/${build.buildId}/review`,
        output: checkOutputForComparisonReport(report),
      }
    : {
        name: existing?.name ?? options.githubCheckName ?? DEFAULT_GITHUB_CHECK_NAME,
        headSha: build.git.commitSha,
        status: "queued",
        detailsUrl: `${options.publicUrl}/v1/builds/${build.buildId}/review`,
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

interface ReviewDecisionFormFields {
  githubLogin?: string;
  githubUserId?: number | string;
  repositoryPermission?: RepositoryPermission;
  user?: {
    login?: string;
    id?: number | string;
    repositoryPermission?: RepositoryPermission;
  };
}

interface ResolvedRepositoryAccess {
  provider: "github";
  login: string;
  id?: number;
  repositoryPermission: RepositoryPermission;
}

async function createReviewDecision(
  buildId: string,
  payload: ReviewDecisionRequest & ReviewDecisionFormFields,
  req: IncomingMessage,
  options: Required<Pick<ApiServerOptions, "storageDir" | "publicUrl" | "comparisonStore" | "reviewStore" | "githubStore">> & ApiServerOptions,
): Promise<ReviewDecision> {
  if (!payload.identityKey) {
    throw new HttpError(400, "identityKey is required.");
  }
  if (payload.state !== "approved" && payload.state !== "rejected") {
    throw new HttpError(400, "state must be approved or rejected.");
  }

  const build = await readBuildRecord(options.storageDir, buildId);
  const report = await options.comparisonStore.getComparisonReport(buildId);
  if (!report) {
    throw new HttpError(404, "Comparison report not found.");
  }
  const comparison = report.comparisons.find((item) => item.identityKey === payload.identityKey);
  if (!comparison) {
    throw new HttpError(404, "Snapshot comparison not found for identityKey.");
  }
  if (comparison.status === "errored") {
    throw new HttpError(400, "Capture errors are hard failures and cannot be approved or rejected as visual changes.");
  }
  if (!comparison.requiresApproval) {
    throw new HttpError(400, "Snapshot comparison does not require visual review.");
  }

  const access = await resolveGitHubRepositoryAccess(req, build, options, payload);
  if (!isReviewableRepositoryPermission(access.repositoryPermission)) {
    throw new HttpError(403, "Approving or rejecting visual changes requires write, maintain, or admin repository permission.");
  }

  const previous = await options.reviewStore.getLatestReviewDecision({ buildId, identityKey: payload.identityKey });
  const now = new Date().toISOString();
  const decision: ReviewDecision = {
    id: randomUUID(),
    buildId,
    identityKey: payload.identityKey,
    state: payload.state,
    user: {
      provider: "github",
      login: access.login,
      id: access.id,
      repositoryPermission: access.repositoryPermission as ReviewableRepositoryPermission,
    },
    previousState: previous?.state,
    createdAt: now,
  };
  await options.reviewStore.saveReviewDecision(decision);
  await options.reviewStore.saveAuditEvent({
    id: randomUUID(),
    repositoryFullName: build.repository.fullName,
    actor: { provider: "github", login: access.login, id: access.id },
    eventType: previous ? "review_decision.updated" : "review_decision.created",
    subjectType: "snapshot",
    subjectId: payload.identityKey,
    buildId,
    identityKey: payload.identityKey,
    metadata: {
      state: payload.state,
      previousState: previous?.state,
      storyId: comparison.story?.id,
      modeName: comparison.mode?.name,
      status: comparison.status,
    },
    createdAt: now,
  });

  const decisions = await options.reviewStore.listReviewDecisions({ buildId });
  const reviewedReport = applyReviewDecisionsToReport(report, decisions);
  const updatedBuild: StoredBuildRecord = {
    ...build,
    status: reviewedReport.checkConclusion === "failure" ? "failed" : "completed",
    checkConclusion: strictCheckConclusionForReport(reviewedReport),
    summary: reviewedReport.summary,
  };
  await writeJsonFile(buildRecordPath(options.storageDir, buildId), updatedBuild);
  await publishGitHubCheckRun(updatedBuild, reviewedReport, options);
  return decision;
}

async function resolveGitHubRepositoryAccess(
  req: IncomingMessage,
  build: StoredBuildRecord,
  options: ApiServerOptions,
  body?: ReviewDecisionFormFields,
): Promise<ResolvedRepositoryAccess> {
  const bodyUser = objectValue(body?.user);
  const login =
    stringHeader(req.headers["x-chroma-snap-github-login"]) ??
    stringHeader(req.headers["x-github-login"]) ??
    stringValue(body?.githubLogin) ??
    stringValue(bodyUser.login);
  const id = optionalNumber(stringHeader(req.headers["x-chroma-snap-github-user-id"]) ?? body?.githubUserId ?? bodyUser.id);
  const headerPermission = stringHeader(req.headers["x-chroma-snap-repository-permission"]) ?? stringHeader(req.headers["x-github-repository-permission"]);
  const bodyPermission = body?.repositoryPermission ?? (bodyUser.repositoryPermission as RepositoryPermission | undefined);

  if (options.allowDevAuth || process.env.CHROMA_SNAP_DEV_AUTH === "1") {
    return {
      provider: "github",
      login: login ?? "local-dev",
      id,
      repositoryPermission: (bodyPermission ?? headerPermission ?? "admin") as RepositoryPermission,
    };
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    throw new HttpError(401, "Review actions require a GitHub OAuth bearer token.");
  }
  if (!login) {
    throw new HttpError(401, "Review actions require the authenticated GitHub login.");
  }
  if (!options.githubPermissionVerifier) {
    throw new HttpError(501, "GitHub permission verification is not configured for review actions.");
  }
  const repositoryPermission = await options.githubPermissionVerifier.getRepositoryPermission({
    repositoryFullName: build.repository.fullName,
    login,
    accessToken: auth.slice("Bearer ".length),
    installationId: numberFromString(build.repository.installationId),
  });
  if (!repositoryPermission) {
    throw new HttpError(403, "Authenticated GitHub user does not have repository access.");
  }
  return { provider: "github", login, id, repositoryPermission };
}

async function assertArtifactReadAccess(
  req: IncomingMessage,
  build: StoredBuildRecord,
  options: ApiServerOptions,
): Promise<void> {
  if (options.allowDevAuth || process.env.CHROMA_SNAP_DEV_AUTH === "1") {
    return;
  }
  await resolveGitHubRepositoryAccess(req, build, options);
}

async function sendSignedArtifact(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: Required<Pick<ApiServerOptions, "artifactStore">> & ApiServerOptions,
): Promise<void> {
  const objectKey = url.searchParams.get("objectKey") ?? "";
  const expiresAt = url.searchParams.get("expiresAt") ?? "";
  const signature = url.searchParams.get("signature") ?? "";
  const buildId = url.searchParams.get("buildId") ?? undefined;
  const verification = verifyArtifactSignature({ objectKey, expiresAt, signature, buildId, secret: artifactSigningSecret(options) });
  if (!verification.ok) {
    throw new HttpError(401, verification.error ?? "Signed artifact URL is invalid.");
  }
  const bytes = await options.artifactStore.readArtifact(objectKey);
  res.statusCode = 200;
  res.setHeader("content-type", contentTypeForObjectKey(objectKey));
  res.setHeader("cache-control", "private, max-age=60");
  res.end(bytes);
}

function signedArtifactUrlsForReport(
  report: ComparisonReport,
  options: Required<Pick<ApiServerOptions, "publicUrl">> & ApiServerOptions,
  buildId: string,
): Record<string, { url: string; expiresAt: string }> {
  const objectKeys = [...artifactObjectKeysForReport(report)];
  if (objectKeys.length === 0) {
    return {};
  }
  const expiresAt = new Date(Date.now() + signedArtifactTtlMs(options)).toISOString();
  const secret = artifactSigningSecret(options);
  return Object.fromEntries(
    objectKeys.map((objectKey) => [
      objectKey,
      { url: createSignedArtifactUrl({ publicUrl: options.publicUrl, objectKey, buildId, expiresAt, secret }), expiresAt },
    ]),
  );
}

function artifactObjectKeysForReport(report: ComparisonReport): Set<string> {
  const objectKeys = new Set<string>();
  for (const comparison of report.comparisons) {
    collectComparisonObjectKeys(comparison, objectKeys);
  }
  return objectKeys;
}

function collectComparisonObjectKeys(comparison: SnapshotComparison, objectKeys: Set<string>): void {
  if (comparison.current?.image?.objectKey) {
    objectKeys.add(comparison.current.image.objectKey);
  }
  if (comparison.current?.logs?.objectKey) {
    objectKeys.add(comparison.current.logs.objectKey);
  }
  if (comparison.baseline?.objectKey) {
    objectKeys.add(comparison.baseline.objectKey);
  }
  if (comparison.diff?.objectKey) {
    objectKeys.add(comparison.diff.objectKey);
  }
}

function artifactSigningSecret(options: ApiServerOptions): string {
  const secret = options.artifactSigningSecret ?? process.env.CHROMA_SNAP_ARTIFACT_SIGNING_SECRET;
  if (secret) {
    return secret;
  }
  if (options.allowDevAuth || process.env.CHROMA_SNAP_DEV_AUTH === "1") {
    return "chroma-snap-local-dev-artifact-signing-secret";
  }
  throw new HttpError(500, "CHROMA_SNAP_ARTIFACT_SIGNING_SECRET is required for signed artifact URLs.");
}

function signedArtifactTtlMs(options: ApiServerOptions): number {
  return Math.max(1, options.signedArtifactUrlTtlSeconds ?? 300) * 1000;
}

function contentTypeForObjectKey(objectKey: string): string {
  switch (extname(objectKey).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".json":
      return "application/json; charset=utf-8";
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
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

function parseBoolean(value: string | null): boolean | undefined {
  if (value === null || value === "") {
    return undefined;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  throw new HttpError(400, `Invalid boolean query value '${value}'.`);
}

function parseOptionalDate(value: string | null): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new HttpError(400, `Invalid date query value '${value}'.`);
  }
  return date;
}

function requestIdFor(req: IncomingMessage): string {
  return stringHeader(req.headers["x-request-id"]) ?? randomUUID();
}

function safeRequestPath(req: IncomingMessage, publicUrl: string): string {
  try {
    return new URL(req.url ?? "/", publicUrl).pathname;
  } catch {
    return req.url ?? "/";
  }
}

async function emitApiMetric(options: ApiServerOptions, event: MetricEvent): Promise<void> {
  try {
    if (options.metricsSink) {
      await options.metricsSink(event);
      return;
    }
    if (process.env.CHROMA_SNAP_METRICS_STDOUT === "1") {
      console.log(metricJsonLine(event));
    }
  } catch {
    // Metrics are intentionally best-effort so observability failures do not block uploads.
  }
}

async function emitRequestLog(options: ApiServerOptions, event: ApiRequestLogEvent): Promise<void> {
  try {
    if (options.requestLogSink) {
      await options.requestLogSink(event);
      return;
    }
    if (options.enableRequestLogging || process.env.CHROMA_SNAP_REQUEST_LOGS === "1") {
      console.log(JSON.stringify(event));
    }
  } catch {
    // Request logging is best-effort.
  }
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

async function readJsonOrForm<T>(req: IncomingMessage): Promise<T> {
  if (!isFormRequest(req)) {
    return readJson<T>(req);
  }
  const params = new URLSearchParams((await readBody(req)).toString("utf8"));
  return Object.fromEntries(params.entries()) as T;
}

function isFormRequest(req: IncomingMessage): boolean {
  return stringHeader(req.headers["content-type"])?.toLowerCase().startsWith("application/x-www-form-urlencoded") ?? false;
}

function reviewDecisionState(value: string | null): "approved" | "rejected" | undefined {
  return value === "approved" || value === "rejected" ? value : undefined;
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  try {
    return JSON.parse((await readBody(req)).toString("utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HttpError(400, "Invalid JSON request body.");
    }
    throw error;
  }
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

class HttpError extends ChromaSnapError {
  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super({ status, message, code: errorCodeForHttpStatus(status), details });
  }
}
