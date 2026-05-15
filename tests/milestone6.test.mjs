import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { processManifest } from "../apps/worker/dist/index.js";
import {
  FileBaselineStore,
  FileComparisonStore,
  FileReviewStore,
  MANIFEST_SCHEMA_VERSION,
  sha256File,
  snapshotIdentityKey,
} from "../packages/shared/dist/index.js";

async function writeSolidPng(path, rgba) {
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = rgba[0];
    png.data[index + 1] = rgba[1];
    png.data[index + 2] = rgba[2];
    png.data[index + 3] = rgba[3];
  }
  await writeFile(path, PNG.sync.write(png));
}

function identityKey() {
  return snapshotIdentityKey({
    repositoryFullName: "acme/widgets",
    projectName: "storybook",
    storyId: "button--primary",
    browserName: "chromium",
    modeName: "default",
    viewport: { width: 2, height: 2, deviceScaleFactor: 1 },
    globals: {},
    configHash: "config-hash",
  });
}

function manifest({ id, branch, baseBranch = "main", pr, imagePath, sha, snapshots, commitSha }) {
  const defaultSnapshots = imagePath || sha
    ? [
        {
          identityKey: identityKey(),
          story: { id: "button--primary", title: "Button", name: "Primary" },
          mode: { name: "default", viewport: { width: 2, height: 2, deviceScaleFactor: 1 }, globals: {} },
          browser: { name: "chromium" },
          status: "captured",
          image: { path: imagePath, sha256: sha, width: 2, height: 2, contentType: "image/png" },
        },
      ]
    : [];
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    manifestId: id,
    generatedAt: "2026-05-15T00:00:00.000Z",
    project: { name: "storybook" },
    repository: { provider: "github", owner: "acme", name: "widgets", fullName: "acme/widgets" },
    git: { commitSha: commitSha ?? `${id}-sha`, branch, baseBranch, ...(pr ? { pullRequestNumber: pr } : {}) },
    configHash: "config-hash",
    capture: {
      adapter: "fixture",
      environment: {},
      thresholds: { maxDiffPixels: 0, maxDiffPixelRatio: 0, includeAntiAliasing: false },
      masks: [],
    },
    snapshots: snapshots ?? defaultSnapshots,
  };
}

function approvalDecision({ buildId, createdAt = "2026-05-15T00:02:00.000Z", state = "approved" } = {}) {
  return {
    id: `decision-${buildId}-${state}`,
    buildId,
    identityKey: identityKey(),
    state,
    user: { provider: "github", login: "octocat", repositoryPermission: "write" },
    createdAt,
  };
}

async function setupStores(dir) {
  return {
    baselineStore: new FileBaselineStore(join(dir, "baselines.json")),
    comparisonStore: new FileComparisonStore(join(dir, "comparisons.json")),
    reviewStore: new FileReviewStore(join(dir, "reviews.json")),
  };
}

test("approved PR snapshot promotes only after matching base-branch confirmation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chroma-snap-m6-promote-"));
  const stores = await setupStores(dir);
  const outputDir = join(dir, "report");
  const oldImage = join(dir, "old.png");
  const approvedImage = join(dir, "approved.png");
  await writeSolidPng(oldImage, [0, 0, 0, 255]);
  await writeSolidPng(approvedImage, [255, 255, 255, 255]);

  await processManifest(manifest({ id: "base-seed", branch: "main", imagePath: oldImage, sha: await sha256File(oldImage) }), {
    ...stores,
    outputDir,
    seedBaselines: true,
    now: new Date("2026-05-15T00:00:00.000Z"),
  });

  const prReport = await processManifest(manifest({ id: "pr-approved", branch: "feature", pr: 12, imagePath: approvedImage, sha: await sha256File(approvedImage) }), {
    ...stores,
    outputDir,
    now: new Date("2026-05-15T00:01:00.000Z"),
  });
  assert.equal(prReport.summary.changed, 1);
  await stores.reviewStore.saveReviewDecision(approvalDecision({ buildId: "pr-approved" }));

  const confirmedReport = await processManifest(manifest({ id: "base-confirm", branch: "main", imagePath: approvedImage, sha: await sha256File(approvedImage), commitSha: "merge-sha" }), {
    ...stores,
    outputDir,
    reconcileApprovedBaselines: true,
    now: new Date("2026-05-15T00:03:00.000Z"),
  });

  assert.equal(confirmedReport.checkConclusion, "success");
  assert.equal(confirmedReport.summary.changed, 1);
  assert.equal(confirmedReport.comparisons[0].requiresApproval, false);
  assert.equal(confirmedReport.comparisons[0].reviewDecision.id, "decision-pr-approved-approved");
  assert.match(confirmedReport.comparisons[0].message, /Promoted baseline/);
  assert.match(confirmedReport.warnings.join("\n"), /Promoted 1 approved baseline/);

  const promoted = await stores.baselineStore.lookupBaseline({
    repositoryFullName: "acme/widgets",
    projectName: "storybook",
    branch: "main",
    identityKey: identityKey(),
  });
  assert.equal(promoted.sha256, await sha256File(approvedImage));
  assert.equal(promoted.buildId, "base-confirm");
  assert.equal(promoted.promotionContext.source, "approved-pr");
  assert.equal(promoted.promotionContext.promotedByDecisionId, "decision-pr-approved-approved");
  assert.equal(promoted.promotionContext.baseBranchConfirmedSha, "merge-sha");

  const auditEvents = await stores.reviewStore.listAuditEvents({ eventType: "baseline.promoted" });
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].metadata.approvedBuildId, "pr-approved");
});

test("mismatched base-branch confirmation does not promote approved PR snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chroma-snap-m6-mismatch-"));
  const stores = await setupStores(dir);
  const outputDir = join(dir, "report");
  const oldImage = join(dir, "old.png");
  const approvedImage = join(dir, "approved.png");
  const mismatchedImage = join(dir, "mismatch.png");
  await writeSolidPng(oldImage, [0, 0, 0, 255]);
  await writeSolidPng(approvedImage, [255, 255, 255, 255]);
  await writeSolidPng(mismatchedImage, [40, 80, 120, 255]);

  await processManifest(manifest({ id: "base-seed", branch: "main", imagePath: oldImage, sha: await sha256File(oldImage) }), {
    ...stores,
    outputDir,
    seedBaselines: true,
    now: new Date("2026-05-15T00:00:00.000Z"),
  });
  await processManifest(manifest({ id: "pr-approved", branch: "feature", pr: 12, imagePath: approvedImage, sha: await sha256File(approvedImage) }), {
    ...stores,
    outputDir,
    now: new Date("2026-05-15T00:01:00.000Z"),
  });
  await stores.reviewStore.saveReviewDecision(approvalDecision({ buildId: "pr-approved" }));

  const mismatchReport = await processManifest(manifest({ id: "base-mismatch", branch: "main", imagePath: mismatchedImage, sha: await sha256File(mismatchedImage) }), {
    ...stores,
    outputDir,
    reconcileApprovedBaselines: true,
    now: new Date("2026-05-15T00:03:00.000Z"),
  });

  assert.equal(mismatchReport.checkConclusion, "action_required");
  assert.equal(mismatchReport.comparisons[0].requiresApproval, true);
  assert.match(mismatchReport.warnings.join("\n"), /did not promote/);

  const baseline = await stores.baselineStore.lookupBaseline({
    repositoryFullName: "acme/widgets",
    projectName: "storybook",
    branch: "main",
    identityKey: identityKey(),
  });
  assert.equal(baseline.sha256, await sha256File(oldImage));

  const auditEvents = await stores.reviewStore.listAuditEvents({ eventType: "baseline.promotion_mismatch" });
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].metadata.actualSha256, await sha256File(mismatchedImage));
});

test("approved deleted stories retire baselines after base-branch confirmation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chroma-snap-m6-retire-"));
  const stores = await setupStores(dir);
  const outputDir = join(dir, "report");
  const oldImage = join(dir, "old.png");
  await writeSolidPng(oldImage, [0, 0, 0, 255]);

  await processManifest(manifest({ id: "base-seed", branch: "main", imagePath: oldImage, sha: await sha256File(oldImage) }), {
    ...stores,
    outputDir,
    seedBaselines: true,
    now: new Date("2026-05-15T00:00:00.000Z"),
  });

  const prDeletionReport = await processManifest(manifest({ id: "pr-delete", branch: "feature", pr: 12, snapshots: [] }), {
    ...stores,
    outputDir,
    now: new Date("2026-05-15T00:01:00.000Z"),
  });
  assert.equal(prDeletionReport.summary.deleted, 1);
  await stores.reviewStore.saveReviewDecision(approvalDecision({ buildId: "pr-delete" }));

  const confirmedDeletion = await processManifest(manifest({ id: "base-delete", branch: "main", snapshots: [] }), {
    ...stores,
    outputDir,
    reconcileApprovedBaselines: true,
    now: new Date("2026-05-15T00:03:00.000Z"),
  });

  assert.equal(confirmedDeletion.checkConclusion, "success");
  assert.equal(confirmedDeletion.summary.deleted, 1);
  assert.equal(confirmedDeletion.comparisons[0].requiresApproval, false);
  assert.equal(confirmedDeletion.comparisons[0].reviewDecision.id, "decision-pr-delete-approved");
  assert.match(confirmedDeletion.comparisons[0].message, /Retired baseline/);

  const baseline = await stores.baselineStore.lookupBaseline({
    repositoryFullName: "acme/widgets",
    projectName: "storybook",
    branch: "main",
    identityKey: identityKey(),
  });
  assert.equal(baseline, undefined);

  const auditEvents = await stores.reviewStore.listAuditEvents({ eventType: "baseline.retired" });
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].metadata.approvedBuildId, "pr-delete");
});
