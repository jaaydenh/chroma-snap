import type { SnapshotManifestEntry } from "./manifest.js";

export type ComparisonStatus = "unchanged" | "changed" | "new" | "deleted" | "errored" | "pending";
export type CheckConclusion = "success" | "failure" | "action_required" | "neutral";
export type ReviewDecisionState = "approved" | "rejected";
export type RepositoryPermission = "read" | "triage" | "write" | "maintain" | "admin";
export type ReviewableRepositoryPermission = Extract<RepositoryPermission, "write" | "maintain" | "admin">;

export interface DiffStats {
  width: number;
  height: number;
  diffPixels: number;
  totalPixels: number;
  diffPixelRatio: number;
  dimensionsChanged: boolean;
}

export interface BaselineReference {
  identityKey: string;
  branch: string;
  buildId: string;
  imagePath?: string;
  objectKey?: string;
  sha256: string;
  createdAt: string;
  promotedAt: string;
}

export interface BaselineRecord extends BaselineReference {
  repositoryFullName: string;
  projectName: string;
  story: SnapshotManifestEntry["story"];
  mode: SnapshotManifestEntry["mode"];
}

export interface SnapshotComparison {
  identityKey: string;
  status: ComparisonStatus;
  story?: SnapshotManifestEntry["story"];
  mode?: SnapshotManifestEntry["mode"];
  current?: SnapshotManifestEntry;
  baseline?: BaselineReference;
  diff?: {
    path?: string;
    objectKey?: string;
    sha256?: string;
    stats: DiffStats;
  };
  requiresApproval: boolean;
  reviewDecision?: ReviewDecision;
  message?: string;
}

export interface ReviewDecision {
  id: string;
  buildId: string;
  identityKey: string;
  state: ReviewDecisionState;
  user: {
    provider: "github";
    login: string;
    id?: number;
    repositoryPermission: ReviewableRepositoryPermission;
  };
  createdAt: string;
  previousState?: ReviewDecisionState;
}

export interface AuditEvent {
  id: string;
  repositoryFullName: string;
  actor?: {
    provider: "github";
    login: string;
    id?: number;
  };
  eventType: "review_decision.created" | "review_decision.updated" | "artifact_url.signed" | "baseline.promoted" | "build.finalized" | string;
  subjectType: "snapshot" | "build" | "artifact" | "baseline" | string;
  subjectId: string;
  buildId?: string;
  identityKey?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ReviewDecisionRequest {
  identityKey: string;
  state: ReviewDecisionState;
}

export interface ComparisonReport {
  buildId: string;
  generatedAt: string;
  baseBranch: string;
  headBranch: string;
  summary: Record<ComparisonStatus, number>;
  checkConclusion: CheckConclusion;
  comparisons: SnapshotComparison[];
  warnings: string[];
}

export function emptySummary(): Record<ComparisonStatus, number> {
  return {
    unchanged: 0,
    changed: 0,
    new: 0,
    deleted: 0,
    errored: 0,
    pending: 0,
  };
}

export function isReviewableRepositoryPermission(permission: RepositoryPermission | string | undefined): permission is ReviewableRepositoryPermission {
  return permission === "write" || permission === "maintain" || permission === "admin";
}

export function latestReviewDecisions(decisions: ReviewDecision[]): Map<string, ReviewDecision> {
  const latest = new Map<string, ReviewDecision>();
  for (const decision of decisions) {
    const existing = latest.get(decision.identityKey);
    if (!existing || Date.parse(existing.createdAt) <= Date.parse(decision.createdAt)) {
      latest.set(decision.identityKey, decision);
    }
  }
  return latest;
}

export function applyReviewDecisionsToReport(report: ComparisonReport, decisions: ReviewDecision[]): ComparisonReport {
  const latest = latestReviewDecisions(decisions.filter((decision) => decision.buildId === report.buildId));
  const comparisons = report.comparisons.map((comparison) => {
    const reviewDecision = latest.get(comparison.identityKey);
    if (!reviewDecision) {
      return comparison;
    }
    return {
      ...comparison,
      reviewDecision,
      requiresApproval: comparison.requiresApproval && reviewDecision.state !== "approved" && reviewDecision.state !== "rejected",
    };
  });

  const hasRejectedDecision = comparisons.some((comparison) => comparison.reviewDecision?.state === "rejected");
  const hasErroredSnapshot = comparisons.some((comparison) => comparison.status === "errored") || report.summary.errored > 0;
  const stillRequiresApproval = comparisons.some((comparison) => comparison.requiresApproval);
  const checkConclusion: CheckConclusion = report.checkConclusion === "failure" || hasErroredSnapshot || hasRejectedDecision ? "failure" : stillRequiresApproval ? "action_required" : report.checkConclusion === "neutral" ? "neutral" : "success";

  return {
    ...report,
    checkConclusion,
    comparisons,
  };
}
