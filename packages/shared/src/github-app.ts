import type { CheckConclusion, ComparisonReport } from "./review.js";

export type GitHubCheckRunStatus = "queued" | "in_progress" | "completed";
export type GitHubCheckRunConclusion = CheckConclusion;

export interface GitHubRepositoryDescriptor {
  id?: number;
  owner: string;
  name: string;
  fullName: string;
  private?: boolean;
}

export interface GitHubInstallationRecord {
  installationId: number;
  appId?: number;
  accountLogin?: string;
  permissions: Record<string, string>;
  repositories: GitHubRepositoryDescriptor[];
  suspendedAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPullRequestRecord {
  repositoryFullName: string;
  number: number;
  action: string;
  title?: string;
  state?: "open" | "closed" | string;
  merged?: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha?: string;
  mergeCommitSha?: string | null;
  senderLogin?: string;
  installationId?: number;
  updatedAt: string;
}

export interface GitHubRefRecord {
  repositoryFullName: string;
  ref: string;
  sha: string;
  before?: string;
  pusher?: string;
  installationId?: number;
  updatedAt: string;
}

export interface GitHubWebhookEventRecord {
  deliveryId: string;
  event: string;
  action?: string;
  processed: boolean;
  duplicate?: boolean;
  receivedAt: string;
  processedAt?: string;
  repositoryFullName?: string;
  installationId?: number;
  payload: unknown;
}

export interface GitHubCheckRunOutput {
  title: string;
  summary: string;
}

export interface GitHubCheckRunRecord {
  buildId: string;
  repositoryFullName: string;
  headSha: string;
  installationId?: number;
  githubCheckRunId?: number;
  name: string;
  status: GitHubCheckRunStatus;
  conclusion?: GitHubCheckRunConclusion;
  detailsUrl?: string;
  output: GitHubCheckRunOutput;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubCheckRunRequest {
  name: string;
  headSha: string;
  status: GitHubCheckRunStatus;
  conclusion?: GitHubCheckRunConclusion;
  detailsUrl?: string;
  output: GitHubCheckRunOutput;
}

export const DEFAULT_GITHUB_CHECK_NAME = "Chroma Snap Visual Tests";

export function strictCheckConclusionForReport(report: ComparisonReport): GitHubCheckRunConclusion {
  if (report.summary.errored > 0 || report.checkConclusion === "failure") {
    return "failure";
  }
  if (report.summary.pending > 0 || report.checkConclusion === "neutral") {
    return "neutral";
  }
  if (report.checkConclusion === "action_required" || report.comparisons.some((comparison) => comparison.requiresApproval)) {
    return "action_required";
  }
  return "success";
}

export function checkOutputForQueuedBuild(): GitHubCheckRunOutput {
  return {
    title: "Visual comparison queued",
    summary: "Screenshots uploaded successfully. Chroma Snap is waiting for the diff worker to compare them against accepted baselines.",
  };
}

export function checkOutputForComparisonReport(report: ComparisonReport): GitHubCheckRunOutput {
  const conclusion = strictCheckConclusionForReport(report);
  const title = titleForConclusion(conclusion);
  const approved = report.comparisons.filter((comparison) => comparison.reviewDecision?.state === "approved").length;
  const rejected = report.comparisons.filter((comparison) => comparison.reviewDecision?.state === "rejected").length;
  const awaitingReview = report.comparisons.filter((comparison) => comparison.requiresApproval).length;
  const summary = [
    `Compared ${report.comparisons.length} snapshots for ${report.headBranch} against ${report.baseBranch}.`,
    `Unchanged: ${report.summary.unchanged}`,
    `Changed: ${report.summary.changed}`,
    `New: ${report.summary.new}`,
    `Deleted: ${report.summary.deleted}`,
    `Errored: ${report.summary.errored}`,
    `Pending: ${report.summary.pending}`,
    `Approved: ${approved}`,
    `Rejected: ${rejected}`,
    `Awaiting review: ${awaitingReview}`,
    ...report.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
  return { title, summary };
}

function titleForConclusion(conclusion: GitHubCheckRunConclusion): string {
  switch (conclusion) {
    case "success":
      return "Visual tests passed";
    case "failure":
      return "Visual tests failed";
    case "action_required":
      return "Visual review required";
    case "neutral":
      return "Visual comparison pending";
  }
}
