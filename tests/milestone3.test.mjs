import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startApiServer } from "../apps/api/dist/index.js";
import { QueueJobProcessor, retryDelayMs } from "../apps/worker/dist/index.js";
import {
  FileBaselineStore,
  FileComparisonStore,
  planRetentionSweep,
} from "../packages/shared/dist/index.js";

function baselineRecord(overrides = {}) {
  return {
    identityKey: "button-primary-identity",
    branch: "main",
    buildId: "base-build",
    imagePath: "/tmp/base.png",
    sha256: "sha-base",
    createdAt: "2026-05-14T00:00:00.000Z",
    promotedAt: "2026-05-14T00:00:00.000Z",
    repositoryFullName: "acme/widgets",
    projectName: "storybook",
    story: { id: "button--primary", title: "Button", name: "Primary" },
    mode: { name: "default", viewport: { width: 2, height: 2, deviceScaleFactor: 1 }, globals: {} },
    ...overrides,
  };
}

function comparisonReport(overrides = {}) {
  return {
    buildId: "pr-build",
    generatedAt: "2026-05-14T00:01:00.000Z",
    baseBranch: "main",
    headBranch: "feature",
    summary: { unchanged: 0, changed: 1, new: 0, deleted: 0, errored: 0, pending: 0 },
    checkConclusion: "action_required",
    warnings: [],
    comparisons: [
      {
        identityKey: "button-primary-identity",
        status: "changed",
        requiresApproval: true,
        story: { id: "button--primary" },
        mode: { name: "default", viewport: { width: 2, height: 2, deviceScaleFactor: 1 }, globals: {} },
      },
    ],
    ...overrides,
  };
}

async function withApi(fn, options = {}) {
  const storageDir = await mkdtemp(join(tmpdir(), "chroma-snap-m3-api-"));
  const { server, url } = await startApiServer({ allowDevAuth: true, host: "127.0.0.1", port: 0, storageDir, ...options });
  try {
    await fn({ storageDir, url });
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    await rm(storageDir, { recursive: true, force: true });
  }
}

test("file baseline and comparison stores persist records idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chroma-snap-stores-"));
  const baselineStore = new FileBaselineStore(join(dir, "baselines.json"));
  const comparisonStore = new FileComparisonStore(join(dir, "comparisons.json"));
  const baseline = baselineRecord();
  const report = comparisonReport({ buildId: "pr-build" });

  await baselineStore.promoteBaseline(baseline);
  await baselineStore.promoteBaseline({ ...baseline, promotedAt: "2026-05-14T00:02:00.000Z" });
  const found = await baselineStore.lookupBaseline({
    repositoryFullName: "acme/widgets",
    projectName: "storybook",
    branch: "main",
    identityKey: "button-primary-identity",
  });
  assert.equal(found.promotedAt, "2026-05-14T00:02:00.000Z");
  assert.equal((await baselineStore.listBaselinesForBranch({ repositoryFullName: "acme/widgets", projectName: "storybook", branch: "main" })).length, 1);

  await comparisonStore.saveComparisonReport(report);
  await comparisonStore.saveComparisonReport({ ...report, warnings: ["reprocessed"] });
  assert.deepEqual((await comparisonStore.getComparisonReport("pr-build")).warnings, ["reprocessed"]);

  await Promise.all([
    baselineStore.promoteBaseline(baselineRecord({ identityKey: "concurrent-a", sha256: "sha-a" })),
    baselineStore.promoteBaseline(baselineRecord({ identityKey: "concurrent-b", sha256: "sha-b" })),
  ]);
  const concurrentBaselines = await baselineStore.listBaselinesForBranch({ repositoryFullName: "acme/widgets", projectName: "storybook", branch: "main" });
  assert.equal(concurrentBaselines.filter((record) => record.identityKey.startsWith("concurrent-")).length, 2);

  await Promise.all([
    comparisonStore.saveComparisonReport(comparisonReport({ buildId: "concurrent-report-a", warnings: ["a"] })),
    comparisonStore.saveComparisonReport(comparisonReport({ buildId: "concurrent-report-b", warnings: ["b"] })),
  ]);
  assert.deepEqual((await comparisonStore.getComparisonReport("concurrent-report-a")).warnings, ["a"]);
  assert.deepEqual((await comparisonStore.getComparisonReport("concurrent-report-b")).warnings, ["b"]);
});

test("API exposes baseline lookup and comparison record endpoints", async () => {
  await withApi(async ({ storageDir, url }) => {
    await mkdir(resolve(storageDir, "builds", "pr-build"), { recursive: true });
    await writeFile(
      resolve(storageDir, "builds", "pr-build", "build.json"),
      `${JSON.stringify({
        buildId: "pr-build",
        sessionId: "session-1",
        repository: { fullName: "acme/widgets" },
        git: { commitSha: "pr-sha", branch: "feature", baseBranch: "main" },
        project: { name: "storybook" },
        status: "queued",
        createdAt: "2026-05-14T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const baselineResponse = await fetch(`${url}/v1/baselines`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseline: baselineRecord() }),
    });
    assert.equal(baselineResponse.status, 200);

    const lookupResponse = await fetch(`${url}/v1/builds/pr-build/baselines?branch=main&identityKey=button-primary-identity`);
    assert.equal(lookupResponse.status, 200);
    assert.equal((await lookupResponse.json()).baseline.sha256, "sha-base");

    const report = comparisonReport({ buildId: "pr-build", checkConclusion: "failure" });
    const saveResponse = await fetch(`${url}/v1/builds/pr-build/comparison-report`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ report }),
    });
    assert.equal(saveResponse.status, 200);

    const reportResponse = await fetch(`${url}/v1/builds/pr-build/comparison-report`);
    assert.equal(reportResponse.status, 200);
    assert.equal((await reportResponse.json()).report.checkConclusion, "failure");

    const build = JSON.parse(await readFile(resolve(storageDir, "builds", "pr-build", "build.json"), "utf8"));
    assert.equal(build.status, "failed");
    assert.equal(build.checkConclusion, "failure");
  });
});

test("API protects write endpoints and returns 404 for missing build routes", async () => {
  await withApi(
    async ({ url }) => {
      const baselineResponse = await fetch(`${url}/v1/baselines`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseline: baselineRecord() }),
      });
      assert.equal(baselineResponse.status, 401);

      const deleteResponse = await fetch(`${url}/v1/baselines`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryFullName: "acme/widgets", projectName: "storybook", branch: "main", identityKey: "missing" }),
      });
      assert.equal(deleteResponse.status, 401);

      const reportResponse = await fetch(`${url}/v1/builds/missing/comparison-report`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ report: comparisonReport({ buildId: "missing" }) }),
      });
      assert.equal(reportResponse.status, 401);

      const checkResponse = await fetch(`${url}/v1/builds/missing/check-run`, { method: "POST" });
      assert.equal(checkResponse.status, 401);
    },
    { allowDevAuth: false },
  );

  await withApi(async ({ url }) => {
    assert.equal((await fetch(`${url}/v1/builds/missing`)).status, 404);
    assert.equal((await fetch(`${url}/v1/builds/missing/baselines`)).status, 404);
    assert.equal((await fetch(`${url}/v1/builds/missing/check-run`, { method: "POST" })).status, 404);
    const response = await fetch(`${url}/v1/builds/missing/comparison-report`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ report: comparisonReport({ buildId: "missing" }) }),
    });
    assert.equal(response.status, 404);
  });
});

test("queue processor retries with exponential backoff and skips terminal jobs", async () => {
  const now = new Date("2026-05-14T00:00:00.000Z");
  let calls = 0;
  const processor = new QueueJobProcessor(
    {
      "diff-build": async () => {
        calls += 1;
        throw new Error("diff failed");
      },
    },
    { maxAttempts: 2, baseBackoffMs: 250, now: () => now },
  );
  const job = {
    id: "job-1",
    type: "diff-build",
    buildId: "build-1",
    payloadJson: "{}",
    status: "pending",
    attempts: 0,
    createdAt: now.toISOString(),
  };

  const first = await processor.executeWithRetry(job);
  assert.equal(first.job.status, "pending");
  assert.equal(first.job.attempts, 1);
  assert.equal(first.job.nextRetryAt, "2026-05-14T00:00:00.250Z");
  assert.equal(retryDelayMs(2, 250), 500);

  const second = await processor.executeWithRetry(first.job);
  assert.equal(second.job.status, "failed");
  assert.equal(second.job.attempts, 2);
  assert.equal(second.job.processedAt, now.toISOString());

  const skipped = await processor.executeWithRetry(second.job);
  assert.equal(skipped.handled, false);
  assert.equal(calls, 2);
});

test("retention planning expires old unprotected records by kind", () => {
  const now = new Date("2026-05-14T00:00:00.000Z");
  const sweep = planRetentionSweep(
    [
      { id: "old-artifact", kind: "artifact", createdAt: "2026-01-01T00:00:00.000Z", objectKey: "old.png" },
      { id: "protected-baseline", kind: "artifact", createdAt: "2026-01-01T00:00:00.000Z", protected: true },
      { id: "recent-comparison", kind: "comparison", createdAt: "2026-05-01T00:00:00.000Z" },
      { id: "old-queue", kind: "queue-job", createdAt: "2026-04-01T00:00:00.000Z" },
      { id: "invalid-created-at", kind: "artifact", createdAt: "not-a-date" },
    ],
    { buildArtifactRetentionDays: 90, comparisonRetentionDays: 30, queueJobRetentionDays: 7 },
    now,
  );

  assert.deepEqual(
    sweep.expired.map((candidate) => candidate.id).sort(),
    ["invalid-created-at", "old-artifact", "old-queue"],
  );
  assert.deepEqual(
    sweep.retained.map((candidate) => candidate.id).sort(),
    ["protected-baseline", "recent-comparison"],
  );
});
