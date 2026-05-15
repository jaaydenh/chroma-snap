export interface RetentionPolicy {
  buildArtifactRetentionDays: number;
  comparisonRetentionDays: number;
  queueJobRetentionDays: number;
}

export interface RetentionCandidate {
  id: string;
  kind: "artifact" | "comparison" | "queue-job" | string;
  createdAt: string;
  objectKey?: string;
  protected?: boolean;
}

export interface RetentionSweepResult {
  expired: RetentionCandidate[];
  retained: RetentionCandidate[];
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  buildArtifactRetentionDays: 90,
  comparisonRetentionDays: 90,
  queueJobRetentionDays: 30,
};

export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

export function isExpired(createdAt: string, now: Date, retentionDays: number): boolean {
  const createdAtMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) {
    return true;
  }
  return createdAtMs < retentionCutoff(now, retentionDays).getTime();
}

export function retentionDaysForKind(policy: RetentionPolicy, kind: RetentionCandidate["kind"]): number {
  switch (kind) {
    case "artifact":
      return policy.buildArtifactRetentionDays;
    case "comparison":
      return policy.comparisonRetentionDays;
    case "queue-job":
      return policy.queueJobRetentionDays;
    default:
      return policy.buildArtifactRetentionDays;
  }
}

export function planRetentionSweep(
  candidates: RetentionCandidate[],
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  now: Date = new Date(),
): RetentionSweepResult {
  const expired: RetentionCandidate[] = [];
  const retained: RetentionCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.protected && isExpired(candidate.createdAt, now, retentionDaysForKind(policy, candidate.kind))) {
      expired.push(candidate);
    } else {
      retained.push(candidate);
    }
  }
  return { expired, retained };
}
