import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  assertValidManifest,
  emptySummary,
  FileBaselineStore,
  sha256File,
  type ArtifactStore,
  type BaselineRecord,
  type BaselineStore,
  type BuildManifest,
  type ComparisonReport,
  type ComparisonStatus,
  type ComparisonStore,
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
  outputDir: string;
  seedBaselines?: boolean;
  now?: Date;
}

export async function processManifest(manifest: BuildManifest, options: ProcessManifestOptions): Promise<ComparisonReport> {
  assertValidManifest(manifest);
  const now = options.now ?? new Date();
  const buildId = manifest.manifestId;
  const baseBranch = manifest.git.baseBranch ?? manifest.git.branch;
  const isBaseBranchRun = manifest.git.branch === baseBranch && manifest.git.pullRequestNumber === undefined;
  const manifestDir = options.manifestPath ? dirname(resolve(options.manifestPath)) : process.cwd();
  const baselineStore = getBaselineStore(options);
  const currentIdentityKeys = new Set(manifest.snapshots.map((snapshot) => snapshot.identityKey));
  const comparisons: SnapshotComparison[] = [];
  const warnings: string[] = [];

  if (!options.seedBaselines && isBaseBranchRun) {
    warnings.push("Base-branch run processed without baseline promotion. Use seedBaselines for initial seeding or approved promotion reconciliation.");
  }

  for (const snapshot of manifest.snapshots) {
    const baseline = await baselineStore.lookupBaseline({
      repositoryFullName: manifest.repository.fullName,
      projectName: manifest.project.name,
      branch: baseBranch,
      identityKey: snapshot.identityKey,
    });
    comparisons.push(await compareSnapshot(snapshot, baseline, manifest, manifestDir, options.outputDir, options.artifactStore));
  }

  const branchBaselines = await baselineStore.listBaselinesForBranch({
    repositoryFullName: manifest.repository.fullName,
    projectName: manifest.project.name,
    branch: baseBranch,
  });
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
    for (const snapshot of manifest.snapshots) {
      if (snapshot.status !== "captured" || !snapshot.image?.sha256) {
        continue;
      }
      await baselineStore.promoteBaseline(
        createBaselineRecord({
          manifest,
          snapshot,
          branch: baseBranch,
          imagePath: resolveImagePath(snapshot.image, manifestDir, options.artifactStore),
          buildId,
          now,
        }),
      );
    }
  }

  if (isBaseBranchRun && options.seedBaselines) {
    for (const comparison of comparisons) {
      if (comparison.status === "new" && comparison.current?.status === "captured") {
        comparison.requiresApproval = false;
        comparison.message = "Seeded as an accepted base-branch baseline.";
      }
    }
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
