export const SCHEMA_VERSION = 1 as const;

export type BuildStatus = "queued" | "processing" | "completed" | "failed";
export type QueueJobStatus = "pending" | "processing" | "completed" | "failed";

export interface RepositoryRow {
  id: string;
  provider: "github";
  owner: string;
  name: string;
  fullName: string;
  installationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UploadSessionRow {
  id: string;
  buildId: string;
  repositoryId: string;
  configHash: string;
  expiresAt: string;
  finalized: boolean;
  createdAt: string;
}

export interface ArtifactRow {
  id: string;
  sessionId: string;
  artifactId: string;
  kind: "screenshot" | "manifest" | "log" | "diff";
  objectKey: string;
  contentType: string;
  sha256?: string;
  byteSize?: number;
  width?: number;
  height?: number;
  createdAt: string;
}

export interface BuildRow {
  id: string;
  sessionId: string;
  repositoryId: string;
  projectName: string;
  branch: string;
  commitSha: string;
  baseBranch?: string;
  mergeBaseSha?: string;
  pullRequestNumber?: number;
  status: BuildStatus;
  reportUrl?: string;
  createdAt: string;
  finalizedAt?: string;
}

export interface BaselineRow {
  id: string;
  repositoryId: string;
  projectName: string;
  branch: string;
  identityKey: string;
  buildId: string;
  objectKey?: string;
  sha256: string;
  storyJson?: string;
  modeJson?: string;
  promotionContextJson?: string;
  createdAt: string;
  promotedAt: string;
}

export interface ComparisonReportRow {
  id: string;
  buildId: string;
  generatedAt: string;
  baseBranch: string;
  headBranch: string;
  checkConclusion: "success" | "failure" | "action_required" | "neutral";
  summaryJson: string;
  warningsJson: string;
  createdAt: string;
}

export interface SnapshotComparisonRow {
  id: string;
  reportId: string;
  identityKey: string;
  status: "unchanged" | "changed" | "new" | "deleted" | "errored" | "pending";
  currentSnapshotJson?: string;
  baselineId?: string;
  diffJson?: string;
  requiresApproval: boolean;
  createdAt: string;
}

export interface ReviewDecisionRow {
  id: string;
  buildId: string;
  identityKey: string;
  state: "approved" | "rejected";
  githubUserLogin: string;
  githubUserId?: number;
  repositoryPermission: "write" | "maintain" | "admin";
  previousState?: "approved" | "rejected";
  createdAt: string;
}

export interface AuditEventRow {
  id: string;
  repositoryId: string;
  actorGithubLogin?: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  metadataJson: string;
  createdAt: string;
}

export interface GitHubInstallationRow {
  id: string;
  appId?: number;
  installationId: number;
  accountLogin?: string;
  permissionsJson: string;
  repositoriesJson: string;
  suspendedAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEventRow {
  id: string;
  githubDeliveryId: string;
  eventType: string;
  action?: string;
  repositoryFullName?: string;
  installationId?: number;
  payloadJson: string;
  processed: boolean;
  receivedAt: string;
  processedAt?: string;
}

export interface PullRequestMetadataRow {
  id: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  action: string;
  title?: string;
  state?: string;
  merged?: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha?: string;
  mergeCommitSha?: string;
  senderLogin?: string;
  installationId?: number;
  updatedAt: string;
}

export interface GitHubRefRow {
  id: string;
  repositoryFullName: string;
  ref: string;
  sha: string;
  beforeSha?: string;
  pusher?: string;
  installationId?: number;
  updatedAt: string;
}

export interface CheckRunRow {
  id: string;
  buildId: string;
  repositoryFullName: string;
  headSha: string;
  installationId?: number;
  githubCheckRunId?: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "action_required" | "neutral";
  detailsUrl?: string;
  outputJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface RetentionPolicyRow {
  id: string;
  repositoryId: string;
  buildArtifactRetentionDays: number;
  comparisonRetentionDays: number;
  queueJobRetentionDays: number;
  createdAt: string;
  updatedAt: string;
}

export interface QueueJobRow {
  id: string;
  type: "diff-build" | "check-update" | "cleanup" | "baseline-promotion" | string;
  buildId?: string;
  payloadJson: string;
  status: QueueJobStatus;
  attempts: number;
  createdAt: string;
  processedAt?: string;
  lastError?: string;
  nextRetryAt?: string;
}
