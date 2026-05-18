import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { startApiServer } from "../apps/api/dist/index.js";
import { createCleanupJobHandler, processManifest } from "../apps/worker/dist/index.js";
import {
  ERROR_CODES,
  FileBaselineStore,
  MANIFEST_SCHEMA_VERSION,
  sha256,
  sha256File,
  snapshotIdentityKey,
} from "../packages/shared/dist/index.js";

function pngBytes(rgba = [20, 40, 60, 255]) {
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = rgba[0];
    png.data[index + 1] = rgba[1];
    png.data[index + 2] = rgba[2];
    png.data[index + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

async function withApi(fn, options = {}) {
  const storageDir = await mkdtemp(join(tmpdir(), "chroma-snap-m7-api-"));
  const metrics = [];
  const requestLogs = [];
  const { server, url } = await startApiServer({
    allowDevAuth: true,
    host: "127.0.0.1",
    port: 0,
    storageDir,
    metricsSink: (event) => metrics.push(event),
    requestLogSink: (event) => requestLogs.push(event),
    ...options,
  });
  try {
    await fn({ storageDir, url, metrics, requestLogs });
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    await rm(storageDir, { recursive: true, force: true });
  }
}

function sessionRequest(bytes = pngBytes()) {
  return {
    repository: { provider: "github", owner: "acme", name: "widgets", fullName: "acme/widgets" },
    git: { commitSha: "abc123", branch: "feature", baseBranch: "main", pullRequestNumber: 42 },
    project: { name: "storybook" },
    configHash: "config-hash",
    artifacts: [
      {
        id: "button--primary.png",
        kind: "screenshot",
        fileName: "button.png",
        contentType: "image/png",
        sha256: sha256(bytes),
        byteSize: bytes.byteLength,
      },
    ],
  };
}

function manifestFor({ session, target, bytes }) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    manifestId: `manifest-${session.sessionId}`,
    generatedAt: "2026-05-15T00:00:00.000Z",
    project: { name: "storybook" },
    repository: { provider: "github", owner: "acme", name: "widgets", fullName: "acme/widgets" },
    git: { commitSha: "abc123", branch: "feature", baseBranch: "main", pullRequestNumber: 42 },
    configHash: "config-hash",
    capture: {
      adapter: "fixture",
      environment: {},
      thresholds: { maxDiffPixels: 0, maxDiffPixelRatio: 0, includeAntiAliasing: false },
      masks: [],
    },
    snapshots: [
      {
        identityKey: "button-primary-identity",
        story: { id: "button--primary", title: "Button", name: "Primary" },
        mode: { name: "default", viewport: { width: 2, height: 2, deviceScaleFactor: 1 }, globals: {} },
        browser: { name: "chromium" },
        status: "captured",
        image: {
          objectKey: target.objectKey,
          sha256: sha256(bytes),
          byteSize: bytes.byteLength,
          width: 2,
          height: 2,
          contentType: "image/png",
        },
      },
    ],
  };
}

async function createSession(url, request = sessionRequest()) {
  const response = await fetch(`${url}/v1/upload-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.status !== 201) {
    assert.fail(`Expected 201, got ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

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

test("Milestone 7 health/readiness endpoints add request IDs and typed errors", async () => {
  await withApi(async ({ url, metrics, requestLogs }) => {
    const health = await fetch(`${url}/health`, { headers: { "x-request-id": "req-health" } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-request-id"), "req-health");
    assert.equal((await health.json()).service, "chroma-snap-api");

    const ready = await fetch(`${url}/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).ready, true);

    const invalid = await fetch(`${url}/v1/upload-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-invalid" },
      body: "{not-json",
    });
    assert.equal(invalid.status, 400);
    const body = await invalid.json();
    assert.equal(body.code, ERROR_CODES.INVALID_REQUEST);
    assert.equal(body.requestId, "req-invalid");

    assert.ok(metrics.some((event) => event.name === "api.request" && event.labels.path === "/health"));
    assert.ok(requestLogs.some((event) => event.requestId === "req-health" && event.path === "/health"));
  });
});

test("Milestone 7 private-beta limits reject oversized upload sessions and manifests", async () => {
  await withApi(
    async ({ url }) => {
      const response = await fetch(`${url}/v1/upload-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionRequest()),
      });
      assert.equal(response.status, 429);
      const body = await response.json();
      assert.equal(body.code, ERROR_CODES.QUOTA_EXCEEDED);
      assert.match(body.error, /artifacts/i);
    },
    { privateBetaLimits: { maxArtifactsPerUploadSession: 0 } },
  );

  await withApi(
    async ({ url }) => {
      const bytes = pngBytes();
      const session = await createSession(url, sessionRequest(bytes));
      const target = session.uploadTargets[0];
      assert.equal((await fetch(target.url, { method: "PUT", headers: target.headers, body: bytes })).status, 200);
      const response = await fetch(`${url}/v1/upload-sessions/${session.sessionId}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest: manifestFor({ session, target, bytes }) }),
      });
      assert.equal(response.status, 429);
      assert.equal((await response.json()).code, ERROR_CODES.QUOTA_EXCEEDED);
    },
    { privateBetaLimits: { maxSnapshotsPerBuild: 0 } },
  );
});

test("Milestone 7 diagnostics and cleanup remove abandoned artifacts and completed queue jobs", async () => {
  await withApi(async ({ storageDir, url, metrics }) => {
    const bytes = pngBytes([80, 90, 100, 255]);
    const session = await createSession(url, sessionRequest(bytes));
    const target = session.uploadTargets[0];
    assert.equal((await fetch(target.url, { method: "PUT", headers: target.headers, body: bytes })).status, 200);

    const sessionPath = resolve(storageDir, "sessions", `${session.sessionId}.json`);
    const storedSession = JSON.parse(await readFile(sessionPath, "utf8"));
    storedSession.createdAt = "2026-01-01T00:00:00.000Z";
    storedSession.expiresAt = "2026-01-01T00:15:00.000Z";
    await writeFile(sessionPath, `${JSON.stringify(storedSession, null, 2)}\n`, "utf8");

    const queuePath = resolve(storageDir, "queue", "old-job.json");
    await writeFile(
      queuePath,
      `${JSON.stringify({ id: "old-job", type: "cleanup", payloadJson: "{}", status: "completed", attempts: 1, createdAt: "2026-01-01T00:00:00.000Z", processedAt: "2026-01-01T00:01:00.000Z" }, null, 2)}\n`,
      "utf8",
    );

    const diagnostics = await (await fetch(`${url}/v1/admin/diagnostics`)).json();
    assert.equal(diagnostics.counts.sessions, 1);
    assert.equal(diagnostics.counts.queueJobs, 1);
    assert.ok(diagnostics.storage.artifactBytes >= bytes.byteLength);

    const cleanup = await fetch(`${url}/v1/admin/cleanup?kind=artifact,queue-job&before=2026-01-02T00:00:00.000Z`, { method: "POST" });
    assert.equal(cleanup.status, 200);
    const result = await cleanup.json();
    assert.equal(result.uploadSessions.deleted, 1);
    assert.equal(result.artifacts.deleted, 1);
    assert.equal(result.queueJobs.deleted, 1);
    assert.deepEqual(result.artifacts.objectKeys, [target.objectKey]);
    assert.ok(metrics.some((event) => event.name === "cleanup.completed"));

    await assert.rejects(() => stat(resolve(storageDir, target.objectKey)), /ENOENT/);
    await assert.rejects(() => stat(sessionPath), /ENOENT/);
    await assert.rejects(() => stat(queuePath), /ENOENT/);
  });
});

test("Milestone 7 worker records comparison errors instead of aborting the whole build", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chroma-snap-m7-worker-"));
  const currentImage = join(dir, "current.png");
  await writeSolidPng(currentImage, [200, 200, 200, 255]);
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
  const baselineStore = new FileBaselineStore(join(dir, "baselines.json"));
  await baselineStore.promoteBaseline({
    identityKey,
    branch: "main",
    buildId: "base",
    imagePath: join(dir, "missing-baseline.png"),
    sha256: "different-baseline-sha",
    createdAt: "2026-05-15T00:00:00.000Z",
    promotedAt: "2026-05-15T00:00:00.000Z",
    repositoryFullName: "acme/widgets",
    projectName: "storybook",
    story: { id: "button--primary", title: "Button", name: "Primary" },
    mode: { name: "default", viewport: { width: 2, height: 2, deviceScaleFactor: 1 }, globals: {} },
  });

  const metrics = [];
  const report = await processManifest(
    {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      manifestId: "worker-error-build",
      generatedAt: "2026-05-15T00:01:00.000Z",
      project: { name: "storybook" },
      repository: { provider: "github", owner: "acme", name: "widgets", fullName: "acme/widgets" },
      git: { commitSha: "worker-error-sha", branch: "feature", baseBranch: "main", pullRequestNumber: 42 },
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
          image: { path: currentImage, sha256: await sha256File(currentImage), width: 2, height: 2, contentType: "image/png" },
        },
      ],
    },
    { baselineStore, outputDir: join(dir, "report"), metricsSink: (event) => metrics.push(event) },
  );

  assert.equal(report.checkConclusion, "failure");
  assert.equal(report.summary.errored, 1);
  assert.match(report.comparisons[0].message, /Worker comparison failed/);
  assert.match(report.warnings.join("\n"), /Diff failed/);
  assert.ok(metrics.some((event) => event.name === "worker.error"));
  assert.ok(metrics.some((event) => event.name === "worker.diff_completed"));
});

test("Milestone 7 cleanup queue handler calls the admin cleanup endpoint", async () => {
  let capturedUrl;
  let capturedHeaders;
  const handler = createCleanupJobHandler(async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = init.headers;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });

  await handler({
    id: "cleanup-job",
    type: "cleanup",
    payloadJson: JSON.stringify({ serviceUrl: "https://snap.example.test/", adminSecret: "secret", kind: "queue-job", before: "2026-01-02T00:00:00.000Z", limit: 10, dryRun: true }),
    status: "pending",
    attempts: 0,
    createdAt: "2026-05-15T00:00:00.000Z",
  });

  assert.equal(capturedUrl, "https://snap.example.test/v1/admin/cleanup?kind=queue-job&before=2026-01-02T00%3A00%3A00.000Z&limit=10&dryRun=true");
  assert.equal(capturedHeaders["x-chroma-snap-admin-secret"], "secret");
});
