import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { diffPngFiles, processManifest } from "../apps/worker/dist/index.js";
import { MANIFEST_SCHEMA_VERSION, sha256File, snapshotIdentityKey } from "../packages/shared/dist/index.js";

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

function manifest({ branch, baseBranch, pr, imagePath, sha, identityKey, id = "build" }) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    manifestId: id,
    generatedAt: "2026-05-13T00:00:00.000Z",
    project: { name: "storybook" },
    repository: { provider: "github", owner: "acme", name: "widgets", fullName: "acme/widgets" },
    git: { commitSha: `${id}-sha`, branch, baseBranch, ...(pr ? { pullRequestNumber: pr } : {}) },
    configHash: "config-hash",
    capture: {
      adapter: "fixture",
      environment: {},
      thresholds: { maxDiffPixels: 0, maxDiffPixelRatio: 0, includeAntiAliasing: false },
      masks: [],
    },
    snapshots: [
      {
        identityKey,
        story: { id: "button--primary", title: "Button", name: "Primary" },
        mode: { name: "default", viewport: { width: 2, height: 2, deviceScaleFactor: 1 }, globals: {} },
        browser: { name: "chromium" },
        status: "captured",
        image: { path: imagePath, sha256: sha, width: 2, height: 2, contentType: "image/png" },
      },
    ],
  };
}

test("PNG diff detects changed pixels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chroma-snap-diff-"));
  const baseline = join(dir, "baseline.png");
  const current = join(dir, "current.png");
  const diff = join(dir, "diff.png");
  await writeSolidPng(baseline, [0, 0, 0, 255]);
  await writeSolidPng(current, [255, 255, 255, 255]);

  const stats = await diffPngFiles(current, baseline, diff);
  assert.equal(stats.totalPixels, 4);
  assert.equal(stats.diffPixels, 4);
});

test("processor seeds base baselines and classifies PR diffs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chroma-snap-worker-"));
  const baselineFile = join(dir, "baselines.json");
  const outputDir = join(dir, "report");
  const baseImage = join(dir, "base.png");
  const currentImage = join(dir, "current.png");
  await writeSolidPng(baseImage, [0, 0, 0, 255]);
  await writeSolidPng(currentImage, [255, 255, 255, 255]);

  const identityKey = snapshotIdentityKey({
    repositoryFullName: "acme/widgets",
    projectName: "storybook",
    storyId: "button--primary",
    browserName: "chromium",
    modeName: "default",
    viewport: { width: 2, height: 2, deviceScaleFactor: 1 },
    globals: {},
    configHash: "config-hash",
  });

  const seedReport = await processManifest(manifest({ branch: "main", imagePath: baseImage, sha: await sha256File(baseImage), identityKey, id: "base" }), {
    baselineFile,
    outputDir,
    seedBaselines: true,
    now: new Date("2026-05-13T00:00:00.000Z"),
  });
  assert.equal(seedReport.checkConclusion, "success");
  assert.equal(seedReport.summary.new, 1);

  const prReport = await processManifest(manifest({ branch: "feature", baseBranch: "main", pr: 12, imagePath: currentImage, sha: await sha256File(currentImage), identityKey, id: "pr" }), {
    baselineFile,
    outputDir,
    now: new Date("2026-05-13T00:01:00.000Z"),
  });
  assert.equal(prReport.checkConclusion, "action_required");
  assert.equal(prReport.summary.changed, 1);
  assert.equal(prReport.comparisons[0].diff.stats.diffPixels, 4);
});

test("processor includes capture error stack, timeout, and logs in failure messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chroma-snap-error-"));
  const report = await processManifest(
    {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      manifestId: "error-build",
      generatedAt: "2026-05-13T00:00:00.000Z",
      project: { name: "storybook" },
      repository: { provider: "github", owner: "acme", name: "widgets", fullName: "acme/widgets" },
      git: { commitSha: "error-sha", branch: "feature", baseBranch: "main", pullRequestNumber: 12 },
      configHash: "config-hash",
      capture: {
        adapter: "fixture",
        environment: {},
        thresholds: { maxDiffPixels: 0, maxDiffPixelRatio: 0, includeAntiAliasing: false },
        masks: [],
      },
      snapshots: [
        {
          identityKey: "error-identity",
          story: { id: "error--story", title: "Error", name: "Story" },
          mode: { name: "default", viewport: { width: 1, height: 1, deviceScaleFactor: 1 }, globals: {} },
          browser: { name: "chromium" },
          status: "errored",
          error: {
            message: "Timeout waiting for fonts",
            stack: "Error: Timeout waiting for fonts\n  at file.ts:123\n  at context.ts:456",
            timeoutMs: 30000,
            logExcerpt: "[debug] loading fonts\n[error] timeout after 30000ms",
          },
        },
      ],
    },
    {
      baselineFile: join(dir, "baselines.json"),
      outputDir: join(dir, "report"),
      now: new Date("2026-05-13T00:00:00.000Z"),
    },
  );

  assert.equal(report.checkConclusion, "failure");
  assert.equal(report.summary.errored, 1);
  assert.match(report.comparisons[0].message, /Timeout waiting for fonts/);
  assert.match(report.comparisons[0].message, /Timeout: 30000ms/);
  assert.match(report.comparisons[0].message, /Stack:/);
  assert.match(report.comparisons[0].message, /Logs:/);
});
