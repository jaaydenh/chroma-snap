import type { SnapshotManifestEntry } from "./manifest.js";

export type ComparisonStatus = "unchanged" | "changed" | "new" | "deleted" | "errored" | "pending";
export type CheckConclusion = "success" | "failure" | "action_required" | "neutral";
export type ReviewDecisionState = "approved" | "rejected";

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
    repositoryPermission: "write" | "maintain" | "admin";
  };
  createdAt: string;
  previousState?: ReviewDecisionState;
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
