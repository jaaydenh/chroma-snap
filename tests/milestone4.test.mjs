import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGitHubAppJwt, FileGitHubIntegrationStore, GitHubAppClient, startApiServer, signGitHubWebhookPayload } from "../apps/api/dist/index.js";
import { MANIFEST_SCHEMA_VERSION, strictCheckConclusionForReport } from "../packages/shared/dist/index.js";

function storeSegment(value) {
  return `b64_${Buffer.from(value, "utf8").toString("base64url")}`;
}

async function withApi(options, fn) {
  const storageDir = await mkdtemp(join(tmpdir(), "chroma-snap-m4-api-"));
  const { server, url } = await startApiServer({ host: "127.0.0.1", port: 0, storageDir, ...options });
  try {
    await fn({ storageDir, url });
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    await rm(storageDir, { recursive: true, force: true });
  }
}

function signedHeaders(secret, deliveryId, event, body) {
  return {
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": event,
    "x-hub-signature-256": signGitHubWebhookPayload(secret, body),
  };
}

function emptyManifest({ manifestId, repository, commitSha }) {
  const [owner, name] = repository.fullName.split("/");
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    manifestId,
    generatedAt: "2026-05-15T00:00:00.000Z",
    project: { name: "storybook" },
    repository: { provider: "github", owner, name, ...repository },
    git: { commitSha, branch: "feature", baseBranch: "main", pullRequestNumber: 42 },
    configHash: "config-hash",
    capture: {
      adapter: "fixture",
      environment: {},
      thresholds: { maxDiffPixels: 0, maxDiffPixelRatio: 0, includeAntiAliasing: false },
      masks: [],
    },
    snapshots: [],
  };
}

function reportFor(buildId, overrides = {}) {
  return {
    buildId,
    generatedAt: "2026-05-15T00:01:00.000Z",
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

async function createEmptyBuild(url, { repository = { fullName: "acme/widgets", installationId: "123" }, commitSha = "abc123" } = {}) {
  const sessionResponse = await fetch(`${url}/v1/upload-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repository: { provider: "github", owner: "acme", name: "widgets", ...repository },
      git: { commitSha, branch: "feature", baseBranch: "main", pullRequestNumber: 42 },
      project: { name: "storybook" },
      configHash: "config-hash",
      artifacts: [],
    }),
  });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json();
  const finalizeResponse = await fetch(`${url}/v1/upload-sessions/${session.sessionId}/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: emptyManifest({ manifestId: `manifest-${session.sessionId}`, repository, commitSha }) }),
  });
  if (finalizeResponse.status !== 202) {
    assert.fail(`Expected 202, got ${finalizeResponse.status}: ${await finalizeResponse.text()}`);
  }
  return { session, finalized: await finalizeResponse.json() };
}

test("GitHub App client signs JWTs and maps check-run create requests", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" });
  const jwt = createGitHubAppJwt(123, privateKeyPem, new Date("2026-05-15T00:00:00.000Z"));
  const [, payload] = jwt.split(".");
  const decodedPayload = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.equal(decodedPayload.iss, "123");
  assert.ok(decodedPayload.exp > decodedPayload.iat);

  const calls = [];
  const client = new GitHubAppClient(
    { appId: 123, privateKeyPem, apiBaseUrl: "https://github.example.test" },
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/access_tokens")) {
        return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      }
      return new Response(JSON.stringify({ id: 987 }), { status: 201 });
    },
  );

  const created = await client.createCheckRun({
    installationId: 456,
    repositoryFullName: "acme/widgets",
    request: {
      name: "Visual Gate",
      headSha: "abc123",
      status: "completed",
      conclusion: "success",
      detailsUrl: "https://snap.example.test/builds/1",
      output: { title: "Visual tests passed", summary: "Unchanged: 10" },
    },
  });

  assert.equal(created.githubCheckRunId, 987);
  assert.equal(calls[0].url, "https://github.example.test/app/installations/456/access_tokens");
  assert.match(calls[0].init.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.equal(calls[1].url, "https://github.example.test/repos/acme/widgets/check-runs");
  assert.equal(calls[1].init.headers.authorization, "Bearer installation-token");
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.head_sha, "abc123");
  assert.equal(body.details_url, "https://snap.example.test/builds/1");
  assert.equal(body.conclusion, "success");
});

test("GitHub webhook endpoint verifies signatures, stores installations, and deduplicates deliveries", async () => {
  const secret = "webhook-secret";
  await withApi({ githubWebhookSecret: secret }, async ({ storageDir, url }) => {
    const payload = {
      action: "created",
      installation: { id: 123, app_id: 456, account: { login: "acme" }, permissions: { checks: "write", contents: "read" } },
      repositories: [{ id: 99, full_name: "acme/widgets", name: "widgets", owner: { login: "acme" }, private: true }],
    };
    const body = Buffer.from(JSON.stringify(payload));
    const invalid = await fetch(`${url}/v1/github/webhooks`, {
      method: "POST",
      headers: { ...signedHeaders(secret, "delivery-1", "installation", body), "x-hub-signature-256": "sha256=bad" },
      body,
    });
    assert.equal(invalid.status, 401);

    const first = await fetch(`${url}/v1/github/webhooks`, {
      method: "POST",
      headers: signedHeaders(secret, "delivery-1", "installation", body),
      body,
    });
    assert.equal(first.status, 202);
    assert.equal((await first.json()).accepted, true);

    const duplicate = await fetch(`${url}/v1/github/webhooks`, {
      method: "POST",
      headers: signedHeaders(secret, "delivery-1", "installation", body),
      body,
    });
    assert.equal(duplicate.status, 202);
    assert.equal((await duplicate.json()).duplicate, true);

    const installation = JSON.parse(await readFile(resolve(storageDir, "github", "installations", "123.json"), "utf8"));
    assert.equal(installation.installationId, 123);
    assert.equal(installation.permissions.checks, "write");
    assert.equal(installation.repositories[0].fullName, "acme/widgets");
  });
});

test("GitHub file store keeps colliding-looking refs in distinct files", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "chroma-snap-github-store-"));
  try {
    const store = new FileGitHubIntegrationStore(storageDir);
    await Promise.all([
      store.saveRef({ repositoryFullName: "acme/widgets", ref: "refs/heads/a/b", sha: "slash-sha", updatedAt: "2026-05-15T00:00:00.000Z" }),
      store.saveRef({ repositoryFullName: "acme/widgets", ref: "refs/heads/a__b", sha: "underscore-sha", updatedAt: "2026-05-15T00:00:00.000Z" }),
    ]);

    assert.equal((await store.getRef("acme/widgets", "refs/heads/a/b")).sha, "slash-sha");
    assert.equal((await store.getRef("acme/widgets", "refs/heads/a__b")).sha, "underscore-sha");
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("GitHub pull_request and push webhooks persist PR/base metadata", async () => {
  const secret = "webhook-secret";
  await withApi({ githubWebhookSecret: secret }, async ({ storageDir, url }) => {
    const pullRequestPayload = {
      action: "opened",
      installation: { id: 123 },
      repository: { id: 99, full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
      sender: { login: "octocat" },
      pull_request: {
        number: 42,
        title: "Change button",
        state: "open",
        merged: false,
        head: { ref: "feature", sha: "head-sha" },
        base: { ref: "main", sha: "base-sha" },
        merge_commit_sha: null,
      },
    };
    const prBody = Buffer.from(JSON.stringify(pullRequestPayload));
    assert.equal(
      (
        await fetch(`${url}/v1/github/webhooks`, {
          method: "POST",
          headers: signedHeaders(secret, "delivery-pr", "pull_request", prBody),
          body: prBody,
        })
      ).status,
      202,
    );

    const pushPayload = {
      ref: "refs/heads/main",
      before: "before-sha",
      after: "after-sha",
      installation: { id: 123 },
      repository: { id: 99, full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
      sender: { login: "octocat" },
    };
    const pushBody = Buffer.from(JSON.stringify(pushPayload));
    assert.equal(
      (
        await fetch(`${url}/v1/github/webhooks`, {
          method: "POST",
          headers: signedHeaders(secret, "delivery-push", "push", pushBody),
          body: pushBody,
        })
      ).status,
      202,
    );

    const pr = JSON.parse(await readFile(resolve(storageDir, "github", "pull-requests", storeSegment("acme/widgets"), "42.json"), "utf8"));
    assert.equal(pr.headSha, "head-sha");
    assert.equal(pr.baseRef, "main");
    assert.equal(pr.senderLogin, "octocat");

    const ref = JSON.parse(await readFile(resolve(storageDir, "github", "refs", storeSegment("acme/widgets"), `${storeSegment("refs/heads/main")}.json`), "utf8"));
    assert.equal(ref.sha, "after-sha");
    assert.equal(ref.before, "before-sha");
  });
});

test("API creates queued check runs on finalized builds and updates strict conclusions after comparison", async () => {
  const calls = { created: [], updated: [] };
  const publisher = {
    async createCheckRun(input) {
      calls.created.push(input);
      return { githubCheckRunId: 98765 };
    },
    async updateCheckRun(input) {
      calls.updated.push(input);
    },
  };

  await withApi({ allowDevAuth: true, githubCheckPublisher: publisher, githubCheckName: "Visual Gate" }, async ({ url }) => {
    const { finalized } = await createEmptyBuild(url);
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].installationId, 123);
    assert.equal(calls.created[0].repositoryFullName, "acme/widgets");
    assert.equal(calls.created[0].request.name, "Visual Gate");
    assert.equal(calls.created[0].request.status, "queued");
    assert.equal(calls.created[0].request.headSha, "abc123");

    const queued = await fetch(`${url}/v1/builds/${finalized.buildId}/check-run`);
    assert.equal(queued.status, 200);
    assert.equal((await queued.json()).checkRun.githubCheckRunId, 98765);

    const report = reportFor(finalized.buildId);
    assert.equal(strictCheckConclusionForReport(report), "action_required");
    const comparisonResponse = await fetch(`${url}/v1/builds/${finalized.buildId}/comparison-report`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ report }),
    });
    assert.equal(comparisonResponse.status, 200, await comparisonResponse.text());

    assert.equal(calls.updated.length, 1);
    assert.equal(calls.updated[0].githubCheckRunId, 98765);
    assert.equal(calls.updated[0].request.status, "completed");
    assert.equal(calls.updated[0].request.conclusion, "action_required");
    assert.match(calls.updated[0].request.output.summary, /Changed: 1/);

    const completed = await fetch(`${url}/v1/builds/${finalized.buildId}/check-run`);
    assert.equal(completed.status, 200);
    const body = await completed.json();
    assert.equal(body.checkRun.status, "completed");
    assert.equal(body.checkRun.conclusion, "action_required");
  });
});
