import { ChromaSnapError, ERROR_CODES } from "./errors.js";
import type { BuildManifest } from "./manifest.js";
import type { CreateUploadSessionRequest } from "./upload.js";

export interface PrivateBetaLimits {
  maxArtifactsPerUploadSession?: number;
  maxArtifactBytesPerUploadSession?: number;
  maxSnapshotsPerBuild?: number;
  maxSnapshotBytesPerBuild?: number;
  maxErroredSnapshotsPerBuild?: number;
  allowlistedRepositories?: string[];
  blockedRepositories?: string[];
}

export interface LimitViolation {
  code:
    | "repository_not_allowlisted"
    | "repository_blocked"
    | "max_artifacts_per_upload_session"
    | "max_artifact_bytes_per_upload_session"
    | "max_snapshots_per_build"
    | "max_snapshot_bytes_per_build"
    | "max_errored_snapshots_per_build";
  message: string;
  actual: number | string;
  limit?: number | string;
}

export const DEFAULT_PRIVATE_BETA_LIMITS: Required<Pick<PrivateBetaLimits, "maxArtifactsPerUploadSession" | "maxArtifactBytesPerUploadSession" | "maxSnapshotsPerBuild" | "maxSnapshotBytesPerBuild" | "maxErroredSnapshotsPerBuild">> = {
  maxArtifactsPerUploadSession: 10_000,
  maxArtifactBytesPerUploadSession: 10 * 1024 * 1024 * 1024,
  maxSnapshotsPerBuild: 10_000,
  maxSnapshotBytesPerBuild: 10 * 1024 * 1024 * 1024,
  maxErroredSnapshotsPerBuild: 10_000,
};

export function mergePrivateBetaLimits(limits: PrivateBetaLimits | undefined): PrivateBetaLimits {
  return { ...DEFAULT_PRIVATE_BETA_LIMITS, ...(limits ?? {}) };
}

export function evaluateUploadSessionLimits(request: CreateUploadSessionRequest, limits: PrivateBetaLimits = DEFAULT_PRIVATE_BETA_LIMITS): LimitViolation[] {
  const merged = mergePrivateBetaLimits(limits);
  const violations: LimitViolation[] = [];
  const repository = request.repository.fullName;
  addRepositoryViolations(repository, merged, violations);

  const artifactCount = request.artifacts.length;
  const artifactBytes = request.artifacts.reduce((sum, artifact) => sum + (artifact.byteSize ?? 0), 0);
  if (merged.maxArtifactsPerUploadSession !== undefined && artifactCount > merged.maxArtifactsPerUploadSession) {
    violations.push({
      code: "max_artifacts_per_upload_session",
      message: `Upload session declares ${artifactCount} artifacts, which exceeds the private-beta limit of ${merged.maxArtifactsPerUploadSession}.`,
      actual: artifactCount,
      limit: merged.maxArtifactsPerUploadSession,
    });
  }
  if (merged.maxArtifactBytesPerUploadSession !== undefined && artifactBytes > merged.maxArtifactBytesPerUploadSession) {
    violations.push({
      code: "max_artifact_bytes_per_upload_session",
      message: `Upload session declares ${artifactBytes} artifact bytes, which exceeds the private-beta limit of ${merged.maxArtifactBytesPerUploadSession}.`,
      actual: artifactBytes,
      limit: merged.maxArtifactBytesPerUploadSession,
    });
  }
  return violations;
}

export function evaluateBuildManifestLimits(manifest: BuildManifest, limits: PrivateBetaLimits = DEFAULT_PRIVATE_BETA_LIMITS): LimitViolation[] {
  const merged = mergePrivateBetaLimits(limits);
  const violations: LimitViolation[] = [];
  addRepositoryViolations(manifest.repository.fullName, merged, violations);

  const snapshotCount = manifest.snapshots.length;
  const erroredSnapshotCount = manifest.snapshots.filter((snapshot) => snapshot.status === "errored").length;
  const snapshotBytes = manifest.snapshots.reduce((sum, snapshot) => sum + (snapshot.image?.byteSize ?? 0) + (snapshot.logs?.byteSize ?? 0), 0);

  if (merged.maxSnapshotsPerBuild !== undefined && snapshotCount > merged.maxSnapshotsPerBuild) {
    violations.push({
      code: "max_snapshots_per_build",
      message: `Build manifest contains ${snapshotCount} snapshots, which exceeds the private-beta limit of ${merged.maxSnapshotsPerBuild}.`,
      actual: snapshotCount,
      limit: merged.maxSnapshotsPerBuild,
    });
  }
  if (merged.maxSnapshotBytesPerBuild !== undefined && snapshotBytes > merged.maxSnapshotBytesPerBuild) {
    violations.push({
      code: "max_snapshot_bytes_per_build",
      message: `Build manifest references ${snapshotBytes} snapshot bytes, which exceeds the private-beta limit of ${merged.maxSnapshotBytesPerBuild}.`,
      actual: snapshotBytes,
      limit: merged.maxSnapshotBytesPerBuild,
    });
  }
  if (merged.maxErroredSnapshotsPerBuild !== undefined && erroredSnapshotCount > merged.maxErroredSnapshotsPerBuild) {
    violations.push({
      code: "max_errored_snapshots_per_build",
      message: `Build manifest contains ${erroredSnapshotCount} errored snapshots, which exceeds the private-beta limit of ${merged.maxErroredSnapshotsPerBuild}.`,
      actual: erroredSnapshotCount,
      limit: merged.maxErroredSnapshotsPerBuild,
    });
  }

  return violations;
}

export function assertWithinPrivateBetaLimits(violations: LimitViolation[]): void {
  if (violations.length === 0) {
    return;
  }
  throw new ChromaSnapError({
    code: ERROR_CODES.QUOTA_EXCEEDED,
    status: 429,
    message: violations.map((violation) => violation.message).join("\n"),
    details: { violations },
  });
}

function addRepositoryViolations(repository: string, limits: PrivateBetaLimits, violations: LimitViolation[]): void {
  if (limits.blockedRepositories?.includes(repository)) {
    violations.push({
      code: "repository_blocked",
      message: `Repository ${repository} is blocked from this private beta instance.`,
      actual: repository,
    });
  }
  if (limits.allowlistedRepositories && limits.allowlistedRepositories.length > 0 && !limits.allowlistedRepositories.includes(repository)) {
    violations.push({
      code: "repository_not_allowlisted",
      message: `Repository ${repository} is not allowlisted for this private beta instance.`,
      actual: repository,
      limit: limits.allowlistedRepositories.join(","),
    });
  }
}
