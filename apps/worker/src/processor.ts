import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  assertValidManifest,
  emptySummary,
  hashObject,
  sha256File,
  type BaselineReference,
  type BuildManifest,
  type ComparisonReport,
  type ComparisonStatus,
  type SnapshotComparison,
  type SnapshotManifestEntry,
} from "@chroma-snap/shared";
import { diffPngFiles } from "./diff.js";

interface StoredBaselineRecord extends BaselineReference {
  repositoryFullName: string;
  projectName: string;
  story: SnapshotManifestEntry["story"];
  mode: SnapshotManifestEntry["mode"];
}

interface BaselineStore {
  version: 1;
  records: Record<string, StoredBaselineRecord>;
}

export interface ProcessManifestOptions {
  manifestPath?: string;
  baselineFile: string;
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
  const baselines = await readBaselineStore(options.baselineFile);
  const currentIdentityKeys = new Set(manifest.snapshots.map((snapshot) => snapshot.identityKey));
  const comparisons: SnapshotComparison[] = [];
  const warnings: string[] = [];

  if (!options.seedBaselines && isBaseBranchRun) {
    warnings.push("Base-branch run processed without baseline promotion. Use seedBaselines for initial seeding or approved promotion reconciliation.");
  }

  for (const snapshot of manifest.snapshots) {
    const baseline = baselines.records[baselineKey(manifest, baseBranch, snapshot.identityKey)];
    comparisons.push(await compareSnapshot(snapshot, baseline, manifest, manifestDir, options.outputDir));
  }

  for (const baseline of Object.values(baselines.records)) {
    if (
      baseline.repositoryFullName === manifest.repository.fullName &&
      baseline.projectName === manifest.project.name &&
      baseline.branch === baseBranch &&
      !currentIdentityKeys.has(baseline.identityKey)
    ) {
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
      const imagePath = resolveImagePath(snapshot.image.path, manifestDir);
      baselines.records[baselineKey(manifest, baseBranch, snapshot.identityKey)] = {
        identityKey: snapshot.identityKey,
        branch: baseBranch,
        buildId,
        imagePath,
        objectKey: snapshot.image.objectKey,
        sha256: snapshot.image.sha256,
        createdAt: now.toISOString(),
        promotedAt: now.toISOString(),
        repositoryFullName: manifest.repository.fullName,
        projectName: manifest.project.name,
        story: snapshot.story,
        mode: snapshot.mode,
      };
    }
    await writeBaselineStore(options.baselineFile, baselines);
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
  return report;
}

export async function processManifestFile(path: string, options: Omit<ProcessManifestOptions, "manifestPath">): Promise<ComparisonReport> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as BuildManifest;
  return processManifest(manifest, { ...options, manifestPath: path });
}

async function compareSnapshot(
  snapshot: SnapshotManifestEntry,
  baseline: StoredBaselineRecord | undefined,
  manifest: BuildManifest,
  manifestDir: string,
  outputDir: string,
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
      message: snapshot.error?.message ?? "Capture failed.",
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
      message: "Captured snapshot is missing image.sha256.",
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

  const currentPath = resolveImagePath(snapshot.image.path, manifestDir);
  const baselinePath = baseline.imagePath;
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

function determineConclusion(comparisons: SnapshotComparison[]): ComparisonReport["checkConclusion"] {
  if (comparisons.some((comparison) => comparison.status === "errored")) {
    return "failure";
  }
  if (comparisons.some((comparison) => comparison.requiresApproval)) {
    return "action_required";
  }
  return "success";
}

function baselineKey(manifest: BuildManifest, branch: string, identityKey: string): string {
  return hashObject({ repositoryFullName: manifest.repository.fullName, projectName: manifest.project.name, branch, identityKey });
}

async function readBaselineStore(path: string): Promise<BaselineStore> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as BaselineStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, records: {} };
    }
    throw error;
  }
}

async function writeBaselineStore(path: string, store: BaselineStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function resolveImagePath(path: string | undefined, manifestDir: string): string | undefined {
  if (!path) {
    return undefined;
  }
  return resolve(manifestDir, path);
}
