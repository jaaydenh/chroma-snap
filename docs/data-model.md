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
  └─ audit_events
```

## Core entities

- **repositories**: GitHub repository identity and GitHub App installation context.
- **upload_sessions**: short-lived CI upload scopes. A finalized session creates one build.
- **artifacts**: screenshots, logs, manifests, and diffs in private object storage. Local development stores them on disk.
- **builds**: a CI/local run for one repository, commit, branch, project, and config hash.
- **baselines**: canonical accepted snapshots per repository, project, branch, and snapshot identity.
- **comparison_reports**: immutable summary for one build.
- **snapshot_comparisons**: per-story/mode comparison results, including diff stats and approval requirements.
- **review_decisions**: approval/rejection records created by authorized GitHub users.
- **audit_events**: append-only operational and user-action audit trail.
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
```

The worker's local baseline store is still a JSON file. The hosted implementation should move baseline, comparison, decision, usage, and audit metadata into PostgreSQL while continuing to keep binary artifacts in private object storage.

## Deferred production work

- Apply migrations through a real migration runner.
- Add a PostgreSQL adapter and connection pooling.
- Add an S3-compatible `ArtifactStore` implementation.
- Add retention cleanup, signed read URLs, GitHub permission checks, and audit-event writes.
