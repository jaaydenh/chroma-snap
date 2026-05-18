# Chroma Snap

Chroma Snap is an Apache-2.0, open-source codebase for a hosted-first visual regression gate for Storybook 10/Vite projects. The v1 product shape is intentionally narrow: GitHub Actions + GitHub App, Chromium-only Storybook screenshots, server-side diffing, hosted review, strict GitHub Checks, private artifacts, approvals, auditability, and base-branch baseline promotion.

This repository now implements the Milestone 0 through Milestone 7 private-beta MVP slice of that plan:

- Shared typed config, manifest, upload, baseline, diff, and review protocol models.
- A Storybook 10/Vite Vitest browser-mode capture adapter with an automatic `afterEach` screenshot hook.
- A CLI that initializes config, runs capture commands, normalizes capture events into manifests, and uploads to an API.
- A local API skeleton for upload sessions, scoped artifact PUTs, manifest finalization, queue records, baseline lookup, comparison report persistence, GitHub webhooks, strict Checks records, review decisions, audit events, signed artifact URLs, health/readiness probes, diagnostics, private-beta limits, cleanup, and structured metrics hooks.
- A worker that performs server-side PNG diffs, classifies new/changed/deleted/errored/unchanged snapshots, persists comparison reports, handles retry metadata, records comparison failures without aborting whole builds, seeds local baselines, emits metrics, and reconciles approved PR snapshots after base-branch confirmation.
- A hosted-review HTML renderer/server with a report list, image viewer, approval/rejection forms, decision state, and audit trail display.
- A GitHub Action wrapper and example workflow.

The code is open from day one, but production-grade self-hosting is not claimed yet. The local API uses file-backed storage plus development auth/storage seams so the core protocol can be exercised before PostgreSQL adapters, S3 adapters, durable queues, production OAuth/OIDC verification, and supported self-hosting are added.

## Monorepo layout

```text
packages/shared                  Config, manifest, upload, review, hashing types
packages/capture-storybook-vitest Storybook 10/Vite Vitest browser capture adapter
packages/capture-fixture         Lightweight fixture adapter for repeatable local validation
packages/cli                     Local and CI command runner
packages/action                  GitHub Action wrapper around the CLI
apps/api                         Upload-session API and GitHub/review service seams
apps/worker                      Diff worker and local baseline processor
apps/web                         Static review report renderer/server
infra                            Hosted deployment and future self-hosting notes
docs                             Protocol and milestone notes
examples                         Example visual config and private-beta workflow
```

## Install and run locally

These steps run the current file-backed private-beta MVP from source. They do not require PostgreSQL, S3, Redis, or a GitHub App.

### Prerequisites

1. Install Node.js 22 or newer.
2. Install npm and Git.
3. For real Storybook capture, use a Storybook 10/Vite project with Vitest browser mode and Playwright Chromium configured. The fixture smoke test below does not require Storybook.

### 1. Install dependencies and build everything

```bash
git clone git@github.com:jaaydenh/chroma-snap.git
cd chroma-snap
npm install
npm run build
```

Run the full validation suite:

```bash
npm test
npm run test:fixture-capture
```

`npm run test:fixture-capture` writes a local fixture manifest at:

```text
.chroma-snap/dogfood/capture/manifest.json
```

### 2. Start the local API

Open a terminal for the API:

```bash
CHROMA_SNAP_DEV_AUTH=1 \
CHROMA_SNAP_METRICS_STDOUT=1 \
CHROMA_SNAP_REQUEST_LOGS=1 \
node apps/api/dist/index.js
```

The API listens on `http://127.0.0.1:4007` by default. Check it from another terminal:

```bash
curl -fsS http://127.0.0.1:4007/health
curl -fsS http://127.0.0.1:4007/ready
```

Local API state is written under `.chroma-snap/server` unless `CHROMA_SNAP_STORAGE_DIR` is set.

### 3. Upload a captured manifest to the API

After `npm run test:fixture-capture`, upload the fixture manifest and screenshots:

```bash
CHROMA_SNAP_DEV_AUTH=1 \
node packages/cli/dist/index.js upload \
  --manifest .chroma-snap/dogfood/capture/manifest.json \
  --service-url http://127.0.0.1:4007
```

The API creates an upload session, verifies artifact hashes and sizes, stores private artifacts locally, writes a build record, and queues a `diff-build` job record.

### 4. Process screenshots and seed local baselines

Run the worker manually for the local file-backed flow:

```bash
node apps/worker/dist/index.js \
  --manifest .chroma-snap/dogfood/capture/manifest.json \
  --baseline-file .chroma-snap/dogfood/baselines.json \
  --output-dir .chroma-snap/dogfood/report \
  --seed-baselines
```

This writes:

```text
.chroma-snap/dogfood/report/comparison-report.json
```

For a later PR or feature-branch style run, omit `--seed-baselines` so screenshots are compared against the accepted base-branch baselines. To reconcile approved PR changes after they land on the base branch, use:

```bash
node apps/worker/dist/index.js \
  --manifest .chroma-snap/dogfood/capture/manifest.json \
  --baseline-file .chroma-snap/dogfood/baselines.json \
  --comparison-file .chroma-snap/dogfood/comparisons.json \
  --review-file .chroma-snap/dogfood/reviews.json \
  --output-dir .chroma-snap/dogfood/report \
  --reconcile-approved
```

### 5. Serve the review UI

Open a terminal for the review UI:

```bash
CHROMA_SNAP_REPORT_DIR=.chroma-snap/dogfood/report \
node apps/web/dist/index.js
```

Open `http://127.0.0.1:4008` to see the report list and visual review page. The static local UI reads comparison reports from `CHROMA_SNAP_REPORT_DIR`. Hosted review decision forms are wired through the API in the hosted path.

### 6. Use diagnostics and cleanup during local testing

With `CHROMA_SNAP_DEV_AUTH=1`, admin endpoints are open for local development:

```bash
curl -fsS http://127.0.0.1:4007/v1/admin/diagnostics
curl -fsS -X POST "http://127.0.0.1:4007/v1/admin/cleanup?kind=artifact,comparison,queue-job&dryRun=true"
```

Outside development auth, set `CHROMA_SNAP_ADMIN_SECRET` on the API and send it with either `x-chroma-snap-admin-secret` or `Authorization: Bearer`.

## Run against a Storybook 10/Vite project

Use this flow in a separate Storybook 10/Vite repository once the packages are published or linked locally. From this repository, replace `npx chroma-snap` with `node /path/to/chroma-snap/packages/cli/dist/index.js`.

### 1. Install or link the Chroma Snap packages

When packages are published, install them in the Storybook repository:

```bash
npm install --save-dev @chroma-snap/cli @chroma-snap/shared @chroma-snap/capture-storybook-vitest
```

During local source development, build this repository first and use `node /path/to/chroma-snap/packages/cli/dist/index.js` anywhere this guide says `npx chroma-snap`.

### 2. Add Chroma Snap config and setup files

```bash
npx chroma-snap init
```

This creates:

```text
visual.config.ts
.storybook/chroma-snap.vitest.setup.ts
.github/workflows/chroma-snap.yml
```

Ensure the generated `.storybook/chroma-snap.vitest.setup.ts` is included in the Storybook Vitest browser-mode setup files, and ensure `visual.config.ts` points at the Storybook Vitest project command, for example:

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
    { name: "mobile-dark", viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true }, colorScheme: "dark", globals: { theme: "dark" } },
  ],
  thresholds: { maxDiffPixels: 100, maxDiffPixelRatio: 0.001 },
  masks: [{ selector: "[data-visual-mask]", reason: "dynamic content" }],
});
```

### 3. Capture locally

```bash
npx chroma-snap capture --config visual.config.ts
```

This runs the configured Storybook Vitest browser-mode command once per named mode and writes:

```text
.chroma-snap/capture/capture-events.jsonl
.chroma-snap/capture/manifest.json
```

If you already have adapter events and only want to rebuild the manifest, use:

```bash
npx chroma-snap capture --config visual.config.ts --no-run
```

### 4. Upload locally or to the hosted service

For local development:

```bash
CHROMA_SNAP_DEV_AUTH=1 \
npx chroma-snap upload \
  --manifest .chroma-snap/capture/manifest.json \
  --service-url http://127.0.0.1:4007
```

For hosted GitHub Actions, the action requests a GitHub Actions OIDC token and sends it to the service. The local MVP still documents production OIDC signature verification as deferred work.

### 5. Add the GitHub Actions workflow

The generated workflow is the starting point. A minimal hosted workflow looks like:

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

Before enforcing PRs, run the workflow on the base branch once to seed baselines. PR builds with no usable baseline should be treated as setup-incomplete until that base-branch seed run exists.

## Storybook 10/Vite capture spike

The v1 capture adapter is deliberately isolated in `packages/capture-storybook-vitest`. The real Storybook 10/Vite spike has been validated externally, and the chosen hook is a Vitest browser-mode setup hook: `beforeEach` applies mode context where possible and `afterEach` captures the final rendered state after render/play completion.

The adapter remains intentionally scoped to Storybook 10/Vite and Chromium-only capture for v1. See [`docs/milestone-0-spike.md`](docs/milestone-0-spike.md).

## V1 workflow target

1. Install the GitHub App and add the GitHub Action.
2. The action authenticates with GitHub Actions OIDC, loads `visual.config.ts`, and runs Storybook/Vitest browser-mode capture.
3. Screenshots and concise logs upload through a scoped upload session.
4. The worker compares screenshots to accepted base-branch baselines.
5. The hosted review UI shows changed, new, deleted, errored, pending, and unchanged snapshots.
6. Authorized GitHub users approve or reject changes.
7. The GitHub Check remains strict: pending while processing or awaiting approval, success when clean or approved, failure for rejected/capture/error/invalid builds.
8. Approved PR snapshots are promoted only after the approved commit lands on the base branch and a base-branch run confirms them.

## GitHub App, Checks, and review local seam

Milestones 4 through 7 add webhook ingestion, strict Check Run records, review decisions, audit events, GitHub-permission gates, signed artifact URLs, approved baseline promotion reconciliation, request IDs, typed errors, diagnostics, cleanup, metrics, and private-beta limits. See [`docs/github-app.md`](docs/github-app.md) for the local endpoints, required webhook secret, optional GitHub App environment variables for publishing Checks, and review action auth notes. See [`docs/dogfood-parallel.md`](docs/dogfood-parallel.md) for the parallel Chromatic dogfood rollout notes.

## Private-beta hardening endpoints

Milestone 7 adds local/private-beta operational seams:

```text
GET  /health
GET  /ready
GET  /v1/admin/diagnostics
POST /v1/admin/cleanup?kind=artifact,comparison,queue-job&before=<ISO>&limit=<N>&dryRun=true
```

Outside development auth, admin endpoints require `CHROMA_SNAP_ADMIN_SECRET` via `x-chroma-snap-admin-secret` or a bearer token. Set `CHROMA_SNAP_METRICS_STDOUT=1` to emit JSON-line metrics from the API and worker, and `CHROMA_SNAP_REQUEST_LOGS=1` to emit structured request logs. See [`docs/private-beta-hardening.md`](docs/private-beta-hardening.md) and [`docs/self-hosting.md`](docs/self-hosting.md).

## Milestone completion map

- **Milestone 0**: Storybook 10/Vite Vitest browser-mode automatic screenshot spike documented in `docs/milestone-0-spike.md`.
- **Milestone 1**: Local capture, config loading, normalized manifests, named modes, masks, thresholds, fixture capture, and CLI flow.
- **Milestone 2**: Upload sessions, scoped artifact uploads, manifest finalization, integrity checks, queue records, and PostgreSQL schema contracts.
- **Milestone 3**: Server-side PNG diffing, baseline lookup, comparison reports, new/deleted/errored classification, retry metadata, and retention foundations.
- **Milestone 4**: GitHub App webhooks, PR/base metadata, refs, strict Check Run records, and GitHub Check publishing seam.
- **Milestone 5**: Review endpoints, approval/rejection permission gates, audit events, signed private artifact URLs, and HTML review UI.
- **Milestone 6**: Approved PR baseline promotion after base-branch confirmation, approved deletion retirement, seeding, and dogfood rollout notes.
- **Milestone 7**: Usage metrics hooks, private-beta limits, cleanup jobs/endpoints, health/readiness/diagnostics, typed errors, observability docs, examples, and future self-hosting migration notes.

## What is intentionally deferred

- PostgreSQL connection/adapters and automated migration runner.
- S3-compatible object storage implementation and lifecycle enforcement.
- Durable queue integration beyond file-backed retry records.
- Production OAuth session handling for the hosted review UI.
- Production OIDC signature verification and required GitHub App installation verification on uploads.
- Full React review UI with keyboard navigation, richer zoom/pan, and threaded review annotations.
- Billing, SSO, SCIM, SOC2 exports, Helm, HA, and supported production self-hosting.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
