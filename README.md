# Chroma Snap

Chroma Snap is an Apache-2.0 visual regression gate for Storybook 10/Vite projects. It captures Chromium screenshots in CI, uploads private artifacts, diffs them against accepted base-branch baselines, shows a hosted review UI, and keeps GitHub Checks strict until changes are clean or approved.

**Status:** private-beta MVP. The repository contains the full open-source code for the CLI, GitHub Action wrapper, Storybook/Vitest capture adapter, API, worker, review UI, migrations, and deployment notes. The supported v1 path is hosted-first. Production-grade self-hosting still needs the deferred PostgreSQL, S3, durable queue, OAuth, and OIDC hardening called out below.

## What is included

- Storybook 10/Vite + Vitest browser-mode capture adapter for Chromium.
- `visual.config.ts` config with named modes, viewport/globals, masks, and thresholds.
- CLI commands for init, capture, upload, and Vitest setup generation.
- Upload sessions, private artifact storage seams, manifest validation, and strict build metadata.
- Server-side PNG diffing, baseline seeding, deleted/new/changed/errored classifications, and approved baseline promotion.
- GitHub App webhook/check-run seams, review decisions, permission gates, audit events, signed artifact URLs, and private-beta cleanup/metrics hooks.
- Static local review UI plus docs for hosted review and future self-hosting.

## Repository layout

```text
packages/shared                   Config, manifest, upload, review, hashing types
packages/capture-storybook-vitest Experimental Storybook 10/Vite Vitest browser capture adapter
packages/capture-fixture          Lightweight fixture adapter for repeatable local validation
packages/cli                      Local and CI command runner
packages/action                   GitHub Action wrapper around the CLI
apps/api                          Upload-session API and GitHub/review service seams
apps/worker                       Diff worker and local baseline processor
apps/web                          Static review report renderer/server
infra                             Hosted deployment and future self-hosting notes
docs                              Protocol, workflow, and milestone notes
examples                          Example visual config and private-beta workflow
```

## Prerequisites

- Node.js 22 or newer.
- npm and Git.
- For real capture: Storybook 10 with Vite, Vitest browser mode, and Playwright Chromium.
- For hosted/CI review: a GitHub repository, GitHub Actions, and a GitHub App installation.

## Quick start from this repository

This runs the file-backed local MVP. It does not require PostgreSQL, S3, Redis, or a GitHub App.

```bash
npm install
npm run build
npm test
npm run test:fixture-capture
```

The fixture command writes a sample manifest to:

```text
.chroma-snap/dogfood/capture/manifest.json
```

Start the local API:

```bash
CHROMA_SNAP_DEV_AUTH=1 \
CHROMA_SNAP_METRICS_STDOUT=1 \
CHROMA_SNAP_REQUEST_LOGS=1 \
node apps/api/dist/index.js
```

In another terminal, verify and upload the fixture run:

```bash
curl -fsS http://127.0.0.1:4007/health
curl -fsS http://127.0.0.1:4007/ready

CHROMA_SNAP_DEV_AUTH=1 \
node packages/cli/dist/index.js upload \
  --manifest .chroma-snap/dogfood/capture/manifest.json \
  --service-url http://127.0.0.1:4007
```

Process the manifest and seed local baselines:

```bash
node apps/worker/dist/index.js \
  --manifest .chroma-snap/dogfood/capture/manifest.json \
  --baseline-file .chroma-snap/dogfood/baselines.json \
  --output-dir .chroma-snap/dogfood/report \
  --seed-baselines
```

Serve the local review UI:

```bash
CHROMA_SNAP_REPORT_DIR=.chroma-snap/dogfood/report \
node apps/web/dist/index.js
```

Open `http://127.0.0.1:4008`.

## Add Chroma Snap to a Storybook project

Install the packages when they are published:

```bash
npm install --save-dev @chroma-snap/cli @chroma-snap/shared @chroma-snap/capture-storybook-vitest
```

During source development, build this repository and replace `npx chroma-snap` with:

```bash
node /path/to/chroma-snap/packages/cli/dist/index.js
```

Initialize a Storybook 10/Vite repository:

```bash
npx chroma-snap init
```

This creates:

```text
visual.config.ts
.storybook/chroma-snap.vitest.setup.ts
.github/workflows/chroma-snap.yml
```

Ensure `.storybook/chroma-snap.vitest.setup.ts` is listed in your Storybook Vitest setup files. Then adjust `visual.config.ts` for your project:

```ts
import { defineConfig } from "@chroma-snap/shared";

export default defineConfig({
  version: 1,
  project: { name: "storybook" },
  storybook: {
    configDir: ".storybook",
    testCommand: "vitest --project storybook",
  },
  modes: [
    { name: "default", viewport: { width: 1280, height: 720 }, colorScheme: "light" },
    {
      name: "mobile-dark",
      viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
      colorScheme: "dark",
      globals: { theme: "dark" },
    },
  ],
  thresholds: { maxDiffPixels: 100, maxDiffPixelRatio: 0.001 },
  masks: [{ selector: "[data-visual-mask]", reason: "dynamic content" }],
});
```

Capture locally:

```bash
npx chroma-snap capture --config visual.config.ts
```

The capture command writes:

```text
.chroma-snap/capture/capture-events.jsonl
.chroma-snap/capture/manifest.json
```

Upload to a local API:

```bash
CHROMA_SNAP_DEV_AUTH=1 \
npx chroma-snap upload \
  --manifest .chroma-snap/capture/manifest.json \
  --service-url http://127.0.0.1:4007
```

## GitHub Actions setup

A minimal workflow for a hosted/private-beta Chroma Snap service is:

```yaml
name: Chroma Snap

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write
  checks: write
  pull-requests: read

jobs:
  visual:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build --if-present
      - name: Capture visual snapshots
        run: npx chroma-snap capture --config visual.config.ts
      - name: Upload visual snapshots
        run: npx chroma-snap upload --manifest .chroma-snap/capture/manifest.json
        env:
          CHROMA_SNAP_SERVICE_URL: ${{ vars.CHROMA_SNAP_SERVICE_URL }}
```

Before enforcing PR checks, run the workflow on the base branch once to seed baselines. A PR run without a usable base-branch baseline should be treated as setup-incomplete.

## Deploy and run a production version

The current code can run as a hosted/private-beta single-node deployment with persistent filesystem storage. It is **not yet production-grade self-hosting**. Before accepting untrusted repositories or private customer screenshots at scale, complete the deferred hardening work: verified GitHub Actions OIDC signatures, required GitHub App installation checks on upload, PostgreSQL adapters, S3-compatible artifact storage, durable queue workers, production OAuth sessions, backups, and lifecycle policies.

### 1. Build a release artifact

```bash
npm ci
npm run build
npm test
```

Deploy the repository contents, `dist` directories, `package.json`, and `package-lock.json` to a Node 22 runtime. Use a persistent volume for API storage, for example `/var/lib/chroma-snap`.

### 2. Configure the API service

Run the API behind HTTPS, usually behind a reverse proxy or load balancer:

```bash
HOST=0.0.0.0 \
PORT=4007 \
CHROMA_SNAP_PUBLIC_URL=https://snap.example.com \
CHROMA_SNAP_STORAGE_DIR=/var/lib/chroma-snap \
CHROMA_SNAP_ARTIFACT_SIGNING_SECRET=<long-random-secret> \
CHROMA_SNAP_ADMIN_SECRET=<operator-secret> \
CHROMA_SNAP_GITHUB_WEBHOOK_SECRET=<github-webhook-secret> \
CHROMA_SNAP_GITHUB_APP_ID=<app-id> \
CHROMA_SNAP_GITHUB_PRIVATE_KEY="$(cat /run/secrets/chroma-snap-github-app.pem)" \
CHROMA_SNAP_GITHUB_CHECK_NAME="Chroma Snap Visual Tests" \
CHROMA_SNAP_OIDC_AUDIENCE=chroma-snap \
CHROMA_SNAP_METRICS_STDOUT=1 \
CHROMA_SNAP_REQUEST_LOGS=1 \
node apps/api/dist/index.js
```

The current API parses stable GitHub Actions OIDC claims but does not yet verify the JWT signature. For a closed private-beta test only, set `CHROMA_SNAP_ALLOW_UNSIGNED_OIDC=1` to accept those parsed claims while you finish production verification. Do not use that bypass for public or untrusted production traffic.

Health and readiness endpoints:

```text
GET /health
GET /ready
```

Admin endpoints require `CHROMA_SNAP_ADMIN_SECRET` outside development auth:

```bash
curl -fsS -H "x-chroma-snap-admin-secret: $CHROMA_SNAP_ADMIN_SECRET" \
  https://snap.example.com/v1/admin/diagnostics

curl -fsS -X POST -H "x-chroma-snap-admin-secret: $CHROMA_SNAP_ADMIN_SECRET" \
  "https://snap.example.com/v1/admin/cleanup?kind=artifact,comparison,queue-job&dryRun=true"
```

### 3. Configure the GitHub App

Create a GitHub App with webhook delivery to:

```text
https://snap.example.com/v1/github/webhooks
```

Recommended private-beta permissions/events:

- Checks: read/write.
- Contents: read.
- Pull requests: read.
- Metadata: read.
- Webhook events: `installation`, `installation_repositories`, `pull_request`, and `push`.

Install the app on each repository that will upload snapshots.

### 4. Run diff processing

The API writes file-backed queue records for finalized builds. In the current MVP, durable queue processing is still a deployment seam. For private beta, run a controlled worker process or scheduled job that reads finalized manifests from the API storage directory and calls the worker with the same persistent baseline/report stores.

Example one-shot base-branch seed:

```bash
node apps/worker/dist/index.js \
  --manifest /var/lib/chroma-snap/builds/<build-id>/manifest.json \
  --baseline-file /var/lib/chroma-snap/baselines.json \
  --output-dir /var/lib/chroma-snap/reports/<build-id> \
  --seed-baselines
```

Example PR comparison or base-branch reconciliation:

```bash
node apps/worker/dist/index.js \
  --manifest /var/lib/chroma-snap/builds/<build-id>/manifest.json \
  --baseline-file /var/lib/chroma-snap/baselines.json \
  --comparison-file /var/lib/chroma-snap/comparisons.json \
  --review-file /var/lib/chroma-snap/reviews.json \
  --output-dir /var/lib/chroma-snap/reports/<build-id> \
  --reconcile-approved
```

### 5. Run the review UI

```bash
HOST=0.0.0.0 \
PORT=4008 \
CHROMA_SNAP_REPORT_DIR=/var/lib/chroma-snap/reports \
node apps/web/dist/index.js
```

Put the review UI behind the same HTTPS boundary as the API, or proxy `/reports` and `/report` to the web process. The static local UI is suitable for private-beta review, while production OAuth-backed sessions remain deferred.

### 6. Operate safely

- Keep `/var/lib/chroma-snap` backed up; it contains local metadata and private artifacts.
- Ship JSON logs and metrics from stdout to your observability backend.
- Run cleanup in dry-run mode first, then schedule non-dry-run cleanup once retention behavior is verified.
- Do not set `CHROMA_SNAP_DEV_AUTH=1` in a hosted environment.
- Do not expose the upload API to untrusted repositories until OIDC signature verification and GitHub App installation checks are production-grade.

## Review and baseline workflow

1. Install the GitHub App and add the GitHub Actions workflow.
2. Run on the base branch to create the initial accepted baselines.
3. Open a PR. CI captures and uploads screenshots.
4. The worker compares screenshots to accepted base-branch baselines.
5. Reviewers approve or reject changed, new, and deleted snapshots.
6. The GitHub Check passes only when there are no blocking diffs or all required diffs are approved.
7. Approved PR snapshots become canonical baselines only after the approved commit lands on the base branch and a base-branch run confirms the same snapshot content.

## Operational endpoints

```text
GET  /health
GET  /ready
GET  /v1/admin/diagnostics
POST /v1/admin/cleanup?kind=artifact,comparison,queue-job&before=<ISO>&limit=<N>&dryRun=true
```

See `docs/private-beta-hardening.md`, `docs/github-app.md`, `docs/upload-protocol.md`, and `docs/self-hosting.md` for protocol and operations details.

## Milestone completion map

- **Milestone 0**: Storybook 10/Vite Vitest browser-mode automatic screenshot spike.
- **Milestone 1**: Local capture, config loading, manifests, modes, masks, thresholds, fixture capture, and CLI flow.
- **Milestone 2**: Upload sessions, scoped artifact uploads, manifest finalization, integrity checks, queue records, and schema contracts.
- **Milestone 3**: Server-side PNG diffing, baseline lookup, comparison reports, new/deleted/errored classification, retry metadata, and retention foundations.
- **Milestone 4**: GitHub App webhooks, PR/base metadata, refs, strict Check Run records, and GitHub Check publishing seam.
- **Milestone 5**: Review endpoints, approval/rejection permission gates, audit events, signed private artifact URLs, and HTML review UI.
- **Milestone 6**: Approved PR baseline promotion after base-branch confirmation, approved deletion retirement, seeding, and dogfood notes.
- **Milestone 7**: Usage metrics hooks, private-beta limits, cleanup jobs/endpoints, health/readiness/diagnostics, typed errors, docs, examples, and migration notes.

## Deferred before production-grade self-hosting

- PostgreSQL connection/adapters and automated migration runner.
- S3-compatible object storage implementation and lifecycle enforcement.
- Durable queue integration beyond file-backed retry records.
- Production OAuth session handling for the hosted review UI.
- Production OIDC signature verification and required GitHub App installation verification on uploads.
- Full React review UI with richer navigation and annotations.
- Billing, SSO, SCIM, SOC2 exports, Helm, HA, and supported production self-hosting.

## License

Apache-2.0. See `LICENSE`.
