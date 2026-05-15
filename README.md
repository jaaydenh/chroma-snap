# Chroma Snap

Chroma Snap is an Apache-2.0, open-source codebase for a hosted-first visual regression gate for Storybook 10/Vite projects. The v1 product shape is intentionally narrow: GitHub Actions + GitHub App, Chromium-only Storybook screenshots, server-side diffing, hosted review, strict GitHub Checks, private artifacts, approvals, auditability, and base-branch baseline promotion.

This repository currently implements the first runnable slice of that plan:

- Shared typed config, manifest, upload, baseline, diff, and review protocol models.
- An experimental Storybook 10/Vite Vitest browser-mode capture adapter with an automatic `afterEach` screenshot hook.
- A CLI that initializes config, runs capture commands, normalizes capture events into manifests, and uploads to an API.
- A local API skeleton for upload sessions, scoped artifact PUTs, manifest finalization, queue records, baseline lookup, comparison report persistence, GitHub webhooks, strict Checks records, review decisions, audit events, and signed artifact URLs.
- A worker that performs server-side PNG diffs, classifies new/changed/deleted/errored/unchanged snapshots, persists comparison reports, handles retry metadata, seeds local baselines, and reconciles approved PR snapshots after base-branch confirmation.
- A hosted-review HTML renderer/server with a report list, image viewer, approval/rejection forms, decision state, and audit trail display.
- A GitHub Action wrapper and example workflow.

The code is open from day one, but production-grade self-hosting is not claimed yet. The local API uses file-backed storage plus development auth/storage seams so the core protocol can be exercised before PostgreSQL, S3, durable queues, and hosted deployment hardening are added.

## Monorepo layout

```text
packages/shared                  Config, manifest, upload, review, hashing types
packages/capture-storybook-vitest Experimental Storybook 10/Vite Vitest browser capture adapter
packages/capture-fixture         Lightweight fixture adapter for repeatable local validation
packages/cli                     Local and CI command runner
packages/action                  GitHub Action wrapper around the CLI
apps/api                         Upload-session API skeleton
apps/worker                      Diff worker and local baseline processor
apps/web                         Static review report renderer/server
infra                            Hosted deployment and future self-hosting notes
docs                             Protocol and milestone notes
examples                         Example visual config
```

## Quick start for development

```bash
npm install
npm run build
npm test
```

Create starter files in a Storybook 10/Vite repo:

```bash
npx chroma-snap init
```

Run capture without invoking Storybook, using any existing adapter events file:

```bash
npx chroma-snap capture --config visual.config.ts --no-run
```

Run the lightweight fixture/dogfood capture workflow without Storybook:

```bash
npm run test:fixture-capture
```

Run the local API in one terminal:

```bash
CHROMA_SNAP_DEV_AUTH=1 node apps/api/dist/index.js
```

Upload a manifest in another terminal:

```bash
CHROMA_SNAP_DEV_AUTH=1 npx chroma-snap upload --manifest .chroma-snap/capture/manifest.json --service-url http://127.0.0.1:4007
```

Process a manifest locally and seed base-branch baselines:

```bash
node apps/worker/dist/index.js --manifest .chroma-snap/capture/manifest.json --seed-baselines
```

Reconcile approved PR changes on a confirming base-branch run:

```bash
node apps/worker/dist/index.js \
  --manifest .chroma-snap/capture/manifest.json \
  --baseline-file .chroma-snap/baselines.json \
  --comparison-file .chroma-snap/comparisons.json \
  --review-file .chroma-snap/reviews.json \
  --reconcile-approved
```

Serve the generated review report:

```bash
node apps/web/dist/index.js
```

## Storybook 10/Vite capture spike

The v1 capture adapter is deliberately isolated in `packages/capture-storybook-vitest`. The real Storybook 10/Vite spike has been validated externally, and the chosen hook is a Vitest browser-mode setup hook: `beforeEach` applies mode context where possible and `afterEach` captures the final rendered state after render/play completion.

The adapter remains experimental while Milestone 1 hardening continues. See [`docs/milestone-0-spike.md`](docs/milestone-0-spike.md).

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

Milestones 4, 5, and 6 add webhook ingestion, strict Check Run records, review decisions, audit events, GitHub-permission gates, signed artifact URLs, and approved baseline promotion reconciliation. See [`docs/github-app.md`](docs/github-app.md) for the local endpoints, required webhook secret, optional GitHub App environment variables for publishing Checks, and review action auth notes. See [`docs/dogfood-parallel.md`](docs/dogfood-parallel.md) for the parallel Chromatic dogfood rollout notes.

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
