import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startApiServer } from "../apps/api/dist/index.js";
import { renderReportHtml, renderReportListHtml } from "../apps/web/dist/index.js";

async function withApi(options, fn) {
  const storageDir = await mkdtemp(join(tmpdir(), "chroma-snap-m5-api-"));
  const { server, url } = await startApiServer({ allowDevAuth: true, host: "127.0.0.1", port: 0, storageDir, ...options });
  try {
    await fn({ storageDir, url });
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    await rm(storageDir, { recursive: true, force: true });
  }
}

async function writeBuild(storageDir, overrides = {}) {
  const build = {
    buildId: "m5-build",
    sessionId: "session-1",
    repository: { fullName: "acme/widgets", installationId: "123" },
    git: { commitSha: "sha-m5", branch: "feature", baseBranch: "main" },
    project: { name: "storybook" },
    status: "queued",
    createdAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
  await mkdir(resolve(storageDir, "builds", build.buildId), { recursive: true });
  await writeFile(resolve(storageDir, "builds", build.buildId, "build.json"), `${JSON.stringify(build, null, 2)}\n`, "utf8");
  return build;
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
        story: { id: "button--primary", title: "Button", name: "Primary" },
        mode: { name: "default", viewport: { width: 2, height: 2, deviceScaleFactor: 1 }, globals: {} },
        current: {
          identityKey: "button-primary-identity",
          story: { id: "button--primary", title: "Button", name: "Primary" },
          mode: { name: "default", viewport: { width: 2, height: 2, deviceScaleFactor: 1 }, globals: {} },
          browser: { name: "chromium" },
          status: "captured",
          image: { objectKey: "artifacts/github/acme/widgets/sha-m5/session/current.png", sha256: "sha-current", contentType: "image/png" },
        },
      },
    ],
    ...overrides,
  };
}

async function assertResponseStatus(response, expectedStatus) {
  if (response.status !== expectedStatus) {
    assert.fail(`Expected ${expectedStatus}, got ${response.status}: ${await response.text()}`);
  }
}

async function saveReport(url, report) {
  const response = await fetch(`${url}/v1/builds/${report.buildId}/comparison-report`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ report }),
  });
  await assertResponseStatus(response, 200);
}

test("review decisions require write-level GitHub permission, audit the actor, and update strict Checks", async () => {
  const calls = { created: [], updated: [] };
  const publisher = {
    async createCheckRun(input) {
      calls.created.push(input);
      return { githubCheckRunId: 555 };
    },
    async updateCheckRun(input) {
      calls.updated.push(input);
    },
  };

  await withApi({ githubCheckPublisher: publisher }, async ({ storageDir, url }) => {
    const build = await writeBuild(storageDir);
    await saveReport(url, reportFor(build.buildId));
    assert.equal(calls.created[0].request.conclusion, "action_required");

    const forbidden = await fetch(`${url}/v1/builds/${build.buildId}/decisions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chroma-snap-github-login": "reader",
        "x-chroma-snap-repository-permission": "read",
      },
      body: JSON.stringify({ identityKey: "button-primary-identity", state: "approved" }),
    });
    assert.equal(forbidden.status, 403);

    const approved = await fetch(`${url}/v1/builds/${build.buildId}/decisions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chroma-snap-github-login": "octocat",
        "x-chroma-snap-github-user-id": "42",
        "x-chroma-snap-repository-permission": "write",
      },
      body: JSON.stringify({ identityKey: "button-primary-identity", state: "approved" }),
    });
    await assertResponseStatus(approved, 201);
    const approvedBody = await approved.json();
    assert.equal(approvedBody.decision.user.login, "octocat");
    assert.equal(approvedBody.decision.user.repositoryPermission, "write");

    const reportResponse = await fetch(`${url}/v1/builds/${build.buildId}/comparison-report`);
    assert.equal(reportResponse.status, 200);
    const reviewed = await reportResponse.json();
    assert.equal(reviewed.report.checkConclusion, "success");
    assert.equal(reviewed.report.comparisons[0].requiresApproval, false);
    assert.equal(reviewed.report.comparisons[0].reviewDecision.state, "approved");

    assert.equal(calls.updated.at(-1).request.conclusion, "success");
    assert.match(calls.updated.at(-1).request.output.summary, /Approved: 1/);

    const auditResponse = await fetch(`${url}/v1/builds/${build.buildId}/audit-events`);
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json();
    assert.equal(audit.auditEvents.length, 1);
    assert.equal(audit.auditEvents[0].actor.login, "octocat");
    assert.equal(audit.auditEvents[0].eventType, "review_decision.created");
  });
});

test("review decisions can be changed and latest rejection fails the check", async () => {
  await withApi({}, async ({ storageDir, url }) => {
    const build = await writeBuild(storageDir);
    await saveReport(url, reportFor(build.buildId));

    const formApprove = await fetch(`${url}/v1/builds/${build.buildId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ identityKey: "button-primary-identity", state: "approved", githubLogin: "maintainer", repositoryPermission: "maintain" }),
      redirect: "manual",
    });
    assert.equal(formApprove.status, 303);

    const reject = await fetch(`${url}/v1/builds/${build.buildId}/decisions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chroma-snap-github-login": "maintainer",
        "x-chroma-snap-repository-permission": "maintain",
      },
      body: JSON.stringify({ identityKey: "button-primary-identity", state: "rejected" }),
    });
    await assertResponseStatus(reject, 201);
    const rejectedBody = await reject.json();
    assert.equal(rejectedBody.decision.previousState, "approved");

    const reviewed = await (await fetch(`${url}/v1/builds/${build.buildId}/comparison-report`)).json();
    assert.equal(reviewed.report.checkConclusion, "failure");
    assert.equal(reviewed.report.comparisons[0].reviewDecision.state, "rejected");
  });
});

test("API issues signed artifact URLs only for artifacts referenced by the build report", async () => {
  await withApi({ artifactSigningSecret: "test-secret", signedArtifactUrlTtlSeconds: 60 }, async ({ storageDir, url }) => {
    const build = await writeBuild(storageDir);
    const objectKey = "artifacts/github/acme/widgets/sha-m5/session/current.png";
    const bytes = Buffer.from("fake png bytes");
    await mkdir(resolve(storageDir, objectKey, ".."), { recursive: true });
    await writeFile(resolve(storageDir, objectKey), bytes);
    await saveReport(url, reportFor(build.buildId));

    const signed = await fetch(`${url}/v1/builds/${build.buildId}/artifact-url?objectKey=${encodeURIComponent(objectKey)}`);
    await assertResponseStatus(signed, 200);
    const { url: signedUrl, expiresAt } = await signed.json();
    assert.ok(Date.parse(expiresAt) > Date.now());

    const artifact = await fetch(signedUrl);
    assert.equal(artifact.status, 200);
    assert.equal(artifact.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), bytes);

    const tamperedUrl = new URL(signedUrl);
    tamperedUrl.searchParams.set("signature", "bad");
    assert.equal((await fetch(tamperedUrl)).status, 401);

    const unknown = await fetch(`${url}/v1/builds/${build.buildId}/artifact-url?objectKey=${encodeURIComponent("artifacts/unknown.png")}`);
    assert.equal(unknown.status, 404);
  });
});

test("web renderer shows report list, image viewer, approval controls, decisions, and audit events", () => {
  const report = reportFor("m5-build");
  const decision = {
    id: "decision-1",
    buildId: "m5-build",
    identityKey: "button-primary-identity",
    state: "approved",
    user: { provider: "github", login: "octocat", repositoryPermission: "write" },
    createdAt: "2026-05-15T00:02:00.000Z",
  };
  const auditEvent = {
    id: "audit-1",
    repositoryFullName: "acme/widgets",
    actor: { provider: "github", login: "octocat" },
    eventType: "review_decision.created",
    subjectType: "snapshot",
    subjectId: "button-primary-identity",
    buildId: "m5-build",
    identityKey: "button-primary-identity",
    metadata: {},
    createdAt: "2026-05-15T00:02:00.000Z",
  };

  const html = renderReportHtml(report, {
    decisions: [decision],
    auditEvents: [auditEvent],
    decisionEndpoint: "/v1/builds/m5-build/decisions",
    artifactUrls: { "artifacts/github/acme/widgets/sha-m5/session/current.png": "https://snap.example.test/signed/current.png" },
  });
  assert.match(html, /Approve/);
  assert.match(html, /Reject/);
  assert.match(html, /Latest decision/);
  assert.match(html, /Audit log/);
  assert.match(html, /https:\/\/snap.example.test\/signed\/current.png/);
  assert.match(html, /class="image-frame"/);

  const listHtml = renderReportListHtml([report]);
  assert.match(listHtml, /Chroma Snap reports/);
  assert.match(listHtml, /\/report\?buildId=m5-build/);
});
