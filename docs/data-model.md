# Data model

Chroma Snap's hosted data model is relational, with private object storage for binary artifacts. The canonical TypeScript row shapes are in `apps/api/src/schema.ts`; the first PostgreSQL migration is `apps/api/migrations/001_initial_schema.sql`.

## Entity relationships

```text
repositories
  ├─ upload_sessions
  │    └─ artifacts
  ├─ builds
  │    ├─ comparison_reports
  │    │    └─ snapshot_comparisons
  │    ├─ review_decisions
  │    └─ queue_jobs
  ├─ baselines
  ├─ check_runs
  ├─ usage_events
  ├─ cleanup_runs
  ├─ private_beta_limits
  ├─ github_installations
  ├─ webhook_events
  ├─ pull_request_metadata
  ├─ github_refs
  └─ audit_events
```

## Core entities

- **repositories**: GitHub repository identity and GitHub App installation context.
- **upload_sessions**: short-lived CI upload scopes. A finalized session creates one build.
- **artifacts**: screenshots, logs, manifests, and diffs in private object storage. Local development stores them on disk.
- **builds**: a CI/local run for one repository, commit, branch, project, and config hash.
- **baselines**: canonical accepted snapshots per repository, project, branch, and snapshot identity, with optional promotion context recording seed or approved-PR reconciliation metadata.
- **comparison_reports**: immutable summary for one build.
- **snapshot_comparisons**: per-story/mode comparison results, including diff stats and approval requirements.
- **check_runs**: strict GitHub Check state for one build, including queued/completed status and conclusion.
- **github_installations**: GitHub App installation metadata and repository scope.
- **webhook_events**: GitHub webhook delivery deduplication and processing audit records.
- **pull_request_metadata** and **github_refs**: PR/base branch metadata captured from GitHub webhooks.
- **review_decisions**: approval/rejection records created by authorized GitHub users.
- **audit_events**: append-only operational and user-action audit trail.
- **usage_events**: metric events for private-beta usage, cost, and reliability analysis.
- **private_beta_limits**: future per-repository overrides for upload, artifact, and snapshot caps.
- **cleanup_runs**: audit records for retention sweeps and freed-byte accounting.
- **queue_jobs**: durable async work for diffing, check updates, cleanup, and baseline promotion.

## Invariants

1. Upload sessions expire quickly and are scoped to one repository, commit SHA, project, and run.
2. Finalization fails if declared artifacts are missing or fail integrity verification.
3. Artifacts are write-once for a given session artifact ID and are addressed by private object keys.
4. One finalized upload session creates one build.
5. One build has at most one comparison report.
6. Baseline identity is repository + project + branch + story/mode/browser/viewport/globals/config hash.
7. PR approval does not mutate baselines until the approved commit lands on the base branch and a base-branch run confirms the snapshot content.
8. Capture/render/play errors are hard failures, not approvable visual diffs.

## Local development mapping

The local API stores records under `.chroma-snap/server`:

```text
.chroma-snap/server/
  sessions/{sessionId}.json
  artifacts/{provider}/{owner}/{repo}/{commitSha}/{sessionId}/{artifactId}
  builds/{buildId}/build.json
  builds/{buildId}/manifest.json
  queue/{buildId}.json
  github/webhooks/{deliveryId}.json
  github/installations/{installationId}.json
  github/pull-requests/{repository}/{number}.json
  github/refs/{repository}/{ref}.json
  github/check-runs/{buildId}.json
  baselines.json
  comparisons.json
  reviews.json
```

Milestone 3 adds file-backed baseline and comparison stores that mirror the PostgreSQL model closely enough for local worker processing and API tests. Queue records now carry `status`, `attempts`, `lastError`, and `nextRetryAt` fields so worker retries can be idempotent before a durable queue adapter exists. Milestone 4 adds file-backed GitHub App webhook, PR/base metadata, and Check Run stores with matching PostgreSQL migration contracts. Milestone 5 adds a file-backed review store for decisions and audit events, plus HMAC-signed artifact URL helpers for private local artifact reads. Milestone 6 records baseline promotion context and uses prior reports plus review decisions to promote approved snapshots or retire approved deletions only after base-branch confirmation. Milestone 7 adds health/readiness diagnostics, JSON-line usage metrics, private-beta limit enforcement, and local retention cleanup for abandoned upload artifacts, expired comparison reports, and terminal queue jobs.

## Deferred production work

- Apply migrations through a real migration runner.
- Add a PostgreSQL adapter and connection pooling.
- Add an S3-compatible `ArtifactStore` implementation.
- Replace file-backed baseline/comparison stores and retry records with PostgreSQL adapters.
- Add production OAuth session handling and hosted review UI hardening.
