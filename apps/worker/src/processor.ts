import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  assertValidManifest,
  createMetricEvent,
  emptySummary,
  FileBaselineStore,
  metricJsonLine,
  sha256File,
  summarizeManifestUsage,
  type ArtifactStore,
  type BaselineRecord,
  type BaselineStore,
  type BuildManifest,
  type AuditEvent,
  type ComparisonReport,
  type ComparisonStatus,
  type ComparisonStore,
  type MetricEvent,
  type MetricSink,
  type ReviewDecision,
  type ReviewStore,
  type SnapshotComparison,
  type SnapshotManifestEntry,
} from "@chroma-snap/shared";
import { diffPngFiles } from "./diff.js";

export interface ProcessManifestOptions {
  manifestPath?: string;
  baselineFile?: string;
  baselineStore?: BaselineStore;
  comparisonStore?: ComparisonStore;
  artifactStore?: ArtifactStore;
  reviewStore?: ReviewStore;
  /** Reconcile approved PR visual decisions when a base-branch run confirms the same snapshot content. */
  reconcileApprovedBaselines?: boolean;
  outputDir: string;
  seedBaselines?: boolean;
  metricsSink?: MetricSink;
  now?: Date;
}

export async function processManifest(manifest: BuildManifest, options: ProcessManifestOptions): Promise<ComparisonReport> {
  assertValidManifest(manifest);
  const started = performance.now();
  const now = options.now ?? new Date();
  const buildId = manifest.manifestId;
  const baseBranch = manifest.git.baseBranch ?? manifest.git.branch;
  const isBaseBranchRun = manifest.git.branch === baseBranch && manifest.git.pullRequestNumber === undefined;
  const manifestDir = options.manifestPath ? dirname(resolve(options.manifestPath)) : process.cwd();
  const baselineStore = getBaselineStore(options);
  const currentIdentityKeys = new Set(manifest.snapshots.map((snapshot) => snapshot.identityKey));
  const comparisons: SnapshotComparison[] = [];
  const warnings: string[] = [];
  const branchBaselineInput = {
    repositoryFullName: manifest.repository.fullName,
    projectName: manifest.project.name,
    branch: baseBranch,
  };
  const branchBaselines = await baselineStore.listBaselinesForBranch(branchBaselineInput);
  const baselinesByIdentityKey = new Map(branchBaselines.map((baseline) => [baseline.identityKey, baseline]));

  if (!options.seedBaselines && isBaseBranchRun) {
    warnings.push("Base-branch run processed without baseline promotion. Use seedBaselines for initial seeding or approved promotion reconciliation.");
  }

  for (const snapshot of manifest.snapshots) {
    const baseline = baselinesByIdentityKey.get(snapshot.identityKey);
    try {
      comparisons.push(await compareSnapshot(snapshot, baseline, manifest, manifestDir, options.outputDir, options.artifactStore));
    } catch (error) {
      const message = formatProcessorErrorMessage(error);
      warnings.push(`Diff failed for ${snapshot.identityKey}: ${message}`);
      comparisons.push({
        identityKey: snapshot.identityKey,
        status: "errored",
        story: snapshot.story,
        mode: snapshot.mode,
        current: snapshot,
        baseline,
        requiresApproval: false,
        message,
      });
      await emitWorkerMetric(options, createMetricEvent({
        name: "worker.error",
        value: 1,
        labels: {
          buildId,
          repository: manifest.repository.fullName,
          project: manifest.project.name,
          identityKey: snapshot.identityKey,
          phase: "diff",
        },
      }));
    }
  }

  for (const baseline of branchBaselines) {
    if (!currentIdentityKeys.has(baseline.identityKey)) {
      comparisons.push({
        identityKey: baseline.identityKey,
        status: "deleted",
        story: baseline.story,
        mode: baseline.mode,
        baseline,
        requiresApproval: true,
        message: "Baseline snapshot was not present in the current manifest.",
      });
    }
  }

  if (isBaseBranchRun && options.seedBaselines) {
    const recordsToPromote = manifest.snapshots
      .filter((snapshot) => snapshot.status === "captured" && Boolean(snapshot.image?.sha256))
      .map((snapshot) =>
        createBaselineRecord({
          manifest,
          snapshot,
          branch: baseBranch,
          imagePath: resolveImagePath(snapshot.image, manifestDir, options.artifactStore),
          buildId,
          promotionContext: {
            source: "seed",
            status: "seeded",
            promotedAt: now.toISOString(),
            baseBranchConfirmedSha: manifest.git.commitSha,
            note: "Seeded from an explicit base-branch seed run.",
          },
          now,
        }),
      );
    await baselineStore.promoteBaselines(recordsToPromote);
  }

  if (isBaseBranchRun && options.seedBaselines) {
    for (const comparison of comparisons) {
      if (comparison.status === "new" && comparison.current?.status === "captured") {
        comparison.requiresApproval = false;
        comparison.message = "Seeded as an accepted base-branch baseline.";
      }
    }
  }

  if (isBaseBranchRun && options.reconcileApprovedBaselines) {
    const reconciliation = await reconcileApprovedBaselineChanges({
      manifest,
      comparisons,
      baselineStore,
      comparisonStore: options.comparisonStore,
      reviewStore: options.reviewStore,
      manifestDir,
      now,
      baseBranch,
      artifactStore: options.artifactStore,
    });
    warnings.push(...reconciliation.warnings);
  }

  const summary = emptySummary();
  for (const comparison of comparisons) {
    summary[comparison.status] += 1;
  }

  const report: ComparisonReport = {
    buildId,
    generatedAt: now.toISOString(),
    baseBranch,
    headBranch: manifest.git.branch,
    summary,
    checkConclusion: determineConclusion(comparisons),
    comparisons,
    warnings,
  };

  await mkdir(options.outputDir, { recursive: true });
  await writeFile(resolve(options.outputDir, "comparison-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await options.comparisonStore?.saveComparisonReport(report);
  const usage = summarizeManifestUsage(manifest);
  await emitWorkerMetric(options, createMetricEvent({
    name: "worker.diff_completed",
    value: Math.round((performance.now() - started) * 1000) / 1000,
    unit: "milliseconds",
    labels: {
      buildId,
      repository: manifest.repository.fullName,
      project: manifest.project.name,
      snapshotCount: usage.snapshotCount,
      changed: summary.changed,
      errored: summary.errored,
      conclusion: report.checkConclusion,
    },
  }));
  await emitWorkerMetric(options, createMetricEvent({
    name: "worker.snapshots_diffed",
    value: comparisons.length,
    labels: { buildId, repository: manifest.repository.fullName, project: manifest.project.name },
  }));
  return report;
}

export async function processManifestFile(path: string, options: Omit<ProcessManifestOptions, "manifestPath">): Promise<ComparisonReport> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as BuildManifest;
  return processManifest(manifest, { ...options, manifestPath: path });
}

async function compareSnapshot(
  snapshot: SnapshotManifestEntry,
  baseline: BaselineRecord | undefined,
  manifest: BuildManifest,
  manifestDir: string,
  outputDir: string,
  artifactStore?: ArtifactStore,
): Promise<SnapshotComparison> {
  if (snapshot.status === "errored") {
    return {
      identityKey: snapshot.identityKey,
      status: "errored",
      story: snapshot.story,
      mode: snapshot.mode,
      current: snapshot,
      baseline,
      requiresApproval: false,
      message: formatCaptureErrorMessage(snapshot),
    };
  }

  if (!snapshot.image?.sha256) {
    return {
      identityKey: snapshot.identityKey,
      status: "errored",
      story: snapshot.story,
      mode: snapshot.mode,
      current: snapshot,
      baseline,
      requiresApproval: false,
      message: formatCaptureErrorMessage(snapshot),
    };
  }

  if (!baseline) {
    return {
      identityKey: snapshot.identityKey,
      status: "new",
      story: snapshot.story,
      mode: snapshot.mode,
      current: snapshot,
      requiresApproval: true,
      message: "No accepted base-branch baseline exists for this story/mode identity.",
    };
  }

  if (baseline.sha256 === snapshot.image.sha256) {
    return {
      identityKey: snapshot.identityKey,
      status: "unchanged",
      story: snapshot.story,
      mode: snapshot.mode,
      current: snapshot,
      baseline,
      requiresApproval: false,
    };
  }

  const currentPath = resolveImagePath(snapshot.image, manifestDir, artifactStore);
  const baselinePath = resolveBaselinePath(baseline, artifactStore);
  if (!currentPath || !baselinePath) {
    return {
      identityKey: snapshot.identityKey,
      status: "changed",
      story: snapshot.story,
      mode: snapshot.mode,
      current: snapshot,
      baseline,
      requiresApproval: true,
      message: "Image hashes differ, but local image paths are unavailable for pixel diff generation.",
    };
  }

  const diffPath = resolve(outputDir, "diffs", `${snapshot.identityKey}-${basename(currentPath)}.diff.png`);
  const stats = await diffPngFiles(currentPath, baselinePath, diffPath, {
    includeAntiAliasing: manifest.capture.thresholds.includeAntiAliasing,
  });
  const diffSha = await sha256File(diffPath);
  const exceedsThreshold =
    stats.dimensionsChanged ||
    stats.diffPixels > manifest.capture.thresholds.maxDiffPixels ||
    stats.diffPixelRatio > manifest.capture.thresholds.maxDiffPixelRatio;
  const status: ComparisonStatus = exceedsThreshold ? "changed" : "unchanged";

  return {
    identityKey: snapshot.identityKey,
    status,
    story: snapshot.story,
    mode: snapshot.mode,
    current: snapshot,
    baseline,
    diff: {
      path: diffPath,
      sha256: diffSha,
      stats,
    },
    requiresApproval: status === "changed",
  };
}

function createBaselineRecord(input: {
  manifest: BuildManifest;
  snapshot: SnapshotManifestEntry;
  branch: string;
  imagePath?: string;
  buildId: string;
  now: Date;
  promotionContext?: BaselineRecord["promotionContext"];
}): BaselineRecord {
  return {
    identityKey: input.snapshot.identityKey,
    branch: input.branch,
    buildId: input.buildId,
    imagePath: input.imagePath,
    objectKey: input.snapshot.image?.objectKey,
    sha256: input.snapshot.image?.sha256 ?? "",
    createdAt: input.now.toISOString(),
    promotedAt: input.now.toISOString(),
    repositoryFullName: input.manifest.repository.fullName,
    projectName: input.manifest.project.name,
    story: input.snapshot.story,
    mode: input.snapshot.mode,
    promotionContext: input.promotionContext,
  };
}

interface ReconcileApprovedBaselineInput {
  manifest: BuildManifest;
  comparisons: SnapshotComparison[];
  baselineStore: BaselineStore;
  comparisonStore?: ComparisonStore;
  reviewStore?: ReviewStore;
  manifestDir: string;
  now: Date;
  baseBranch: string;
  artifactStore?: ArtifactStore;
}

interface ApprovedComparisonCandidate {
  decision: ReviewDecision;
  report: ComparisonReport;
  comparison: SnapshotComparison;
  approvedSha256?: string;
}

async function reconcileApprovedBaselineChanges(input: ReconcileApprovedBaselineInput): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  if (!input.reviewStore) {
    warnings.push("Approved baseline reconciliation requested, but no review store is configured.");
    return { warnings };
  }
  if (!input.comparisonStore?.listComparisonReports) {
    warnings.push("Approved baseline reconciliation requested, but the comparison store cannot list prior reports.");
    return { warnings };
  }

  const [reports, decisions] = await Promise.all([
    input.comparisonStore.listComparisonReports(),
    input.reviewStore.listReviewDecisions({}),
  ]);
  const approvedCandidates = approvedCandidatesByIdentity({ reports, decisions, baseBranch: input.baseBranch });
  const baselinesToPromote: BaselineRecord[] = [];
  const baselinesToRetire: SnapshotComparison[] = [];
  const auditEvents: AuditEvent[] = [];

  for (const comparison of input.comparisons) {
    const candidates = approvedCandidates.get(comparison.identityKey) ?? [];
    if (comparison.status === "deleted") {
      const deletionCandidate = latestCandidate(candidates.filter((candidate) => candidate.comparison.status === "deleted"));
      if (deletionCandidate) {
        await input.baselineStore.deleteBaseline({
          repositoryFullName: input.manifest.repository.fullName,
          projectName: input.manifest.project.name,
          branch: input.baseBranch,
          identityKey: comparison.identityKey,
        });
        comparison.requiresApproval = false;
        comparison.reviewDecision = deletionCandidate.decision;
        comparison.message = `Retired baseline after approved deletion from ${deletionCandidate.report.headBranch} was confirmed on ${input.baseBranch}.`;
        baselinesToRetire.push(comparison);
        auditEvents.push(baselineAuditEvent({
          eventType: "baseline.retired",
          manifest: input.manifest,
          comparison,
          candidate: deletionCandidate,
          now: input.now,
          metadata: { baseBranch: input.baseBranch },
        }));
      }
      continue;
    }

    if (comparison.current?.status !== "captured" || !comparison.current.image?.sha256 || !comparison.requiresApproval) {
      continue;
    }

    const visualCandidates = candidates.filter((candidate) => candidate.comparison.status === "changed" || candidate.comparison.status === "new");
    const matchingCandidate = latestCandidate(visualCandidates.filter((candidate) => candidate.approvedSha256 === comparison.current?.image?.sha256));
    if (matchingCandidate) {
      const baseline = createBaselineRecord({
        manifest: input.manifest,
        snapshot: comparison.current,
        branch: input.baseBranch,
        imagePath: resolveImagePath(comparison.current.image, input.manifestDir, input.artifactStore),
        buildId: input.manifest.manifestId,
        now: input.now,
        promotionContext: {
          source: "approved-pr",
          status: "confirmed",
          promotedAt: input.now.toISOString(),
          promotedByDecisionId: matchingCandidate.decision.id,
          approvedBuildId: matchingCandidate.report.buildId,
          approvedHeadBranch: matchingCandidate.report.headBranch,
          approvedSha256: matchingCandidate.approvedSha256,
          baseBranchConfirmedSha: input.manifest.git.commitSha,
          note: `Approved PR snapshot was confirmed by base-branch run ${input.manifest.manifestId}.`,
        },
      });
      baselinesToPromote.push(baseline);
      comparison.requiresApproval = false;
      comparison.reviewDecision = matchingCandidate.decision;
      comparison.message = `Promoted baseline after approved ${matchingCandidate.report.headBranch} snapshot was confirmed on ${input.baseBranch}.`;
      auditEvents.push(baselineAuditEvent({
        eventType: "baseline.promoted",
        manifest: input.manifest,
        comparison,
        candidate: matchingCandidate,
        now: input.now,
        metadata: {
          baseBranch: input.baseBranch,
          approvedSha256: matchingCandidate.approvedSha256,
          baseBranchConfirmedSha: input.manifest.git.commitSha,
        },
      }));
      continue;
    }

    const mismatchedCandidate = latestCandidate(visualCandidates.filter((candidate) => Boolean(candidate.approvedSha256)));
    if (mismatchedCandidate) {
      const warning = `Approved baseline reconciliation for ${comparison.identityKey} did not promote: base-branch image ${comparison.current.image.sha256} does not match approved image ${mismatchedCandidate.approvedSha256}.`;
      warnings.push(warning);
      auditEvents.push(baselineAuditEvent({
        eventType: "baseline.promotion_mismatch",
        manifest: input.manifest,
        comparison,
        candidate: mismatchedCandidate,
        now: input.now,
        metadata: {
          baseBranch: input.baseBranch,
          approvedSha256: mismatchedCandidate.approvedSha256,
          actualSha256: comparison.current.image.sha256,
          warning,
        },
      }));
    }
  }

  if (baselinesToPromote.length > 0) {
    await input.baselineStore.promoteBaselines(baselinesToPromote);
  }
  for (const event of auditEvents) {
    await input.reviewStore.saveAuditEvent(event);
  }

  if (baselinesToPromote.length > 0) {
    warnings.push(`Promoted ${baselinesToPromote.length} approved baseline${baselinesToPromote.length === 1 ? "" : "s"} after base-branch confirmation.`);
  }
  if (baselinesToRetire.length > 0) {
    warnings.push(`Retired ${baselinesToRetire.length} approved deleted baseline${baselinesToRetire.length === 1 ? "" : "s"} after base-branch confirmation.`);
  }

  return { warnings };
}

function approvedCandidatesByIdentity(input: {
  reports: ComparisonReport[];
  decisions: ReviewDecision[];
  baseBranch: string;
}): Map<string, ApprovedComparisonCandidate[]> {
  const reportsByBuildId = new Map(input.reports.map((report) => [report.buildId, report]));
  const latestByBuildAndIdentity = new Map<string, ReviewDecision>();
  for (const decision of input.decisions) {
    const key = `${decision.buildId}\0${decision.identityKey}`;
    const existing = latestByBuildAndIdentity.get(key);
    if (!existing || Date.parse(existing.createdAt) <= Date.parse(decision.createdAt)) {
      latestByBuildAndIdentity.set(key, decision);
    }
  }

  const byIdentity = new Map<string, ApprovedComparisonCandidate[]>();
  for (const decision of latestByBuildAndIdentity.values()) {
    if (decision.state !== "approved") {
      continue;
    }
    const report = reportsByBuildId.get(decision.buildId);
    if (!report || report.baseBranch !== input.baseBranch || report.headBranch === input.baseBranch) {
      continue;
    }
    const comparison = report.comparisons.find((candidate) => candidate.identityKey === decision.identityKey);
    if (!comparison) {
      continue;
    }
    const candidates = byIdentity.get(decision.identityKey) ?? [];
    candidates.push({ decision, report, comparison, approvedSha256: comparison.current?.image?.sha256 });
    byIdentity.set(decision.identityKey, candidates);
  }
  return byIdentity;
}

function latestCandidate(candidates: ApprovedComparisonCandidate[]): ApprovedComparisonCandidate | undefined {
  return candidates.sort((a, b) => Date.parse(a.decision.createdAt) - Date.parse(b.decision.createdAt)).at(-1);
}

function baselineAuditEvent(input: {
  eventType: "baseline.promoted" | "baseline.retired" | "baseline.promotion_mismatch";
  manifest: BuildManifest;
  comparison: SnapshotComparison;
  candidate: ApprovedComparisonCandidate;
  now: Date;
  metadata: Record<string, unknown>;
}): AuditEvent {
  return {
    id: `${input.eventType}:${input.manifest.manifestId}:${input.comparison.identityKey}:${input.candidate.decision.id}`,
    repositoryFullName: input.manifest.repository.fullName,
    actor: { provider: "github", login: "chroma-snap-worker" },
    eventType: input.eventType,
    subjectType: "baseline",
    subjectId: input.comparison.identityKey,
    buildId: input.manifest.manifestId,
    identityKey: input.comparison.identityKey,
    metadata: {
      ...input.metadata,
      approvedBuildId: input.candidate.report.buildId,
      approvedHeadBranch: input.candidate.report.headBranch,
      decisionId: input.candidate.decision.id,
      decisionCreatedAt: input.candidate.decision.createdAt,
      reviewer: input.candidate.decision.user.login,
      storyId: input.comparison.story?.id,
      modeName: input.comparison.mode?.name,
    },
    createdAt: input.now.toISOString(),
  };
}

function determineConclusion(comparisons: SnapshotComparison[]): ComparisonReport["checkConclusion"] {
  if (comparisons.some((comparison) => comparison.status === "errored")) {
    return "failure";
  }
  if (comparisons.some((comparison) => comparison.requiresApproval)) {
    return "action_required";
  }
  return "success";
}

function getBaselineStore(options: ProcessManifestOptions): BaselineStore {
  if (options.baselineStore) {
    return options.baselineStore;
  }
  return new FileBaselineStore(resolve(options.baselineFile ?? ".chroma-snap/baselines.json"));
}

function formatProcessorErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack ? `\n\nStack:\n${error.stack.split("\n").slice(0, 8).join("\n")}` : "";
    return `Worker comparison failed: ${error.message}${stack}`;
  }
  return `Worker comparison failed: ${String(error)}`;
}

async function emitWorkerMetric(options: ProcessManifestOptions, event: MetricEvent): Promise<void> {
  try {
    if (options.metricsSink) {
      await options.metricsSink(event);
      return;
    }
    if (process.env.CHROMA_SNAP_METRICS_STDOUT === "1") {
      console.log(metricJsonLine(event));
    }
  } catch {
    // Metrics are best-effort and must not change visual gate results.
  }
}

export function formatCaptureErrorMessage(snapshot: SnapshotManifestEntry): string {
  const parts: string[] = [];
  if (snapshot.error?.message) {
    parts.push(snapshot.error.message);
  } else if (snapshot.status === "captured") {
    parts.push("Captured snapshot is missing image.sha256. Check capture adapter output and upload integrity.");
  } else {
    parts.push("Capture failed without an error message. Check runner logs for this story and mode.");
  }

  if (snapshot.error?.code) {
    parts.push(`Code: ${snapshot.error.code}`);
  }
  if (snapshot.error?.timeoutMs !== undefined) {
    parts.push(`Timeout: ${snapshot.error.timeoutMs}ms`);
  }
  if (snapshot.error?.stack) {
    parts.push(`Stack:\n${snapshot.error.stack.split("\n").slice(0, 8).join("\n")}`);
  }
  if (snapshot.error?.logExcerpt) {
    parts.push(`Logs:\n${snapshot.error.logExcerpt.split("\n").slice(-12).join("\n")}`);
  }

  return parts.join("\n\n");
}

function resolveImagePath(image: SnapshotManifestEntry["image"], manifestDir: string, artifactStore?: ArtifactStore): string | undefined {
  if (image?.path) {
    return resolve(manifestDir, image.path);
  }
  if (image?.objectKey && artifactStore?.localPath) {
    return artifactStore.localPath(image.objectKey);
  }
  return undefined;
}

function resolveBaselinePath(baseline: BaselineRecord, artifactStore?: ArtifactStore): string | undefined {
  if (baseline.imagePath) {
    return baseline.imagePath;
  }
  if (baseline.objectKey && artifactStore?.localPath) {
    return artifactStore.localPath(baseline.objectKey);
  }
  return undefined;
}
