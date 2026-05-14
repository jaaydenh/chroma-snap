import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { startApiServer } from "../apps/api/dist/index.js";
import { MANIFEST_SCHEMA_VERSION, sha256 } from "../packages/shared/dist/index.js";

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

async function withApi(fn) {
  const storageDir = await mkdtemp(join(tmpdir(), "chroma-snap-api-"));
  const { server, url } = await startApiServer({ allowDevAuth: true, host: "127.0.0.1", port: 0, storageDir });
  try {
    await fn({ storageDir, url });
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

function manifestFor({ session, target, bytes, commitSha = "abc123", repositoryFullName = "acme/widgets" }) {
  const [owner, name] = repositoryFullName.split("/");
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    manifestId: `manifest-${session.sessionId}`,
    generatedAt: "2026-05-14T00:00:00.000Z",
    project: { name: "storybook" },
    repository: { provider: "github", owner, name, fullName: repositoryFullName },
    git: { commitSha, branch: "feature", baseBranch: "main", pullRequestNumber: 42 },
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

test("API creates upload sessions with scoped targets", async () => {
  await withApi(async ({ url }) => {
    const session = await createSession(url);
    assert.ok(session.sessionId);
    assert.ok(session.buildId);
    assert.equal(session.uploadTargets.length, 1);
    assert.equal(session.uploadTargets[0].artifactId, "button--primary.png");
    assert.match(session.uploadTargets[0].objectKey, /^artifacts\/github\/acme\/widgets\/abc123\//);
    assert.ok(new Date(session.expiresAt).getTime() > Date.now());
  });
});

test("API stores uploaded artifacts and records session status", async () => {
  await withApi(async ({ storageDir, url }) => {
    const bytes = pngBytes();
    const session = await createSession(url, sessionRequest(bytes));
    const target = session.uploadTargets[0];
    const response = await fetch(target.url, { method: "PUT", headers: target.headers, body: bytes });
    if (response.status !== 200) {
      assert.fail(`Expected 200, got ${response.status}: ${await response.text()}`);
    }

    const stored = await readFile(resolve(storageDir, target.objectKey));
    assert.deepEqual(stored, bytes);
    const storedSession = JSON.parse(await readFile(resolve(storageDir, "sessions", `${session.sessionId}.json`), "utf8"));
    assert.equal(storedSession.artifacts[0].status, "uploaded");
    assert.equal(storedSession.artifacts[0].actualSha256, sha256(bytes));
    assert.equal(storedSession.artifacts[0].actualByteSize, bytes.byteLength);
  });
});

test("API rejects unknown artifact IDs", async () => {
  await withApi(async ({ url }) => {
    const session = await createSession(url);
    const response = await fetch(`${url}/v1/upload-sessions/${session.sessionId}/artifacts/not-declared.png`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: pngBytes(),
    });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /not part of this upload session/i);
  });
});

test("API finalization is idempotent after a valid upload", async () => {
  await withApi(async ({ url }) => {
    const bytes = pngBytes([100, 80, 20, 255]);
    const session = await createSession(url, sessionRequest(bytes));
    const target = session.uploadTargets[0];
    assert.equal((await fetch(target.url, { method: "PUT", headers: target.headers, body: bytes })).status, 200);

    const manifest = manifestFor({ session, target, bytes });
    const first = await fetch(`${url}/v1/upload-sessions/${session.sessionId}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest }),
    });
    if (first.status !== 202) {
      assert.fail(`Expected 202, got ${first.status}: ${await first.text()}`);
    }
    const firstBody = await first.json();
    assert.equal(firstBody.status, "queued");

    const second = await fetch(`${url}/v1/upload-sessions/${session.sessionId}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest }),
    });
    if (second.status !== 202) {
      assert.fail(`Expected 202, got ${second.status}: ${await second.text()}`);
    }
    const secondBody = await second.json();
    assert.equal(secondBody.buildId, firstBody.buildId);
    assert.equal(secondBody.status, "accepted");
  });
});

test("API finalization rejects missing or mismatched artifact uploads", async () => {
  await withApi(async ({ url }) => {
    const bytes = pngBytes();
    const session = await createSession(url, sessionRequest(bytes));
    const target = session.uploadTargets[0];
    const response = await fetch(`${url}/v1/upload-sessions/${session.sessionId}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: manifestFor({ session, target, bytes }) }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /declared but never uploaded/i);
  });

  await withApi(async ({ url }) => {
    const declaredBytes = pngBytes([1, 2, 3, 255]);
    const uploadedBytes = pngBytes([200, 100, 50, 255]);
    const session = await createSession(url, sessionRequest(declaredBytes));
    const target = session.uploadTargets[0];
    assert.equal((await fetch(target.url, { method: "PUT", headers: target.headers, body: uploadedBytes })).status, 200);
    const response = await fetch(`${url}/v1/upload-sessions/${session.sessionId}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: manifestFor({ session, target, bytes: declaredBytes }) }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /sha256 mismatch/i);
  });
});

test("API finalization rejects repository and commit spoofing", async () => {
  await withApi(async ({ url }) => {
    const bytes = pngBytes();
    const session = await createSession(url, sessionRequest(bytes));
    const target = session.uploadTargets[0];
    assert.equal((await fetch(target.url, { method: "PUT", headers: target.headers, body: bytes })).status, 200);

    const response = await fetch(`${url}/v1/upload-sessions/${session.sessionId}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: manifestFor({ session, target, bytes, commitSha: "wrong-sha" }) }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /commit SHA does not match/i);
  });
});
