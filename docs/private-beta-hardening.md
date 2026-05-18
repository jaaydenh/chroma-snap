# Private-beta hardening

Milestone 7 adds the first operational guardrails needed to run Chroma Snap with private beta users while keeping the supported path hosted-first and local-file backed for development.

## Health, readiness, and diagnostics

The API exposes probe endpoints for deployment checks:

```text
GET /health   # liveness, no storage checks
GET /healthz  # compatibility alias
GET /ready    # checks local storage is reachable
GET /readyz   # compatibility alias
```

Every API response includes an `x-request-id`. If the caller sends `x-request-id`, the API preserves it; otherwise it generates a UUID. Error responses include the same request ID plus a stable error code:

```json
{
  "error": "Invalid JSON request body.",
  "code": "INVALID_REQUEST",
  "status": 400,
  "requestId": "..."
}
```

Private diagnostics are available at:

```text
GET /v1/admin/diagnostics
```

The local implementation reports counts for sessions, builds, queue jobs, comparison reports, audit events, and artifact bytes under the filesystem storage root.

## Admin authentication

Admin endpoints are development-open only when `CHROMA_SNAP_DEV_AUTH=1` or `allowDevAuth` is set in tests. Otherwise set `CHROMA_SNAP_ADMIN_SECRET` and pass it as either:

```text
x-chroma-snap-admin-secret: <secret>
Authorization: Bearer <secret>
```

This is intentionally minimal for the local MVP. Hosted production should replace it with internal service auth and operator RBAC.

## Private-beta limits

The API enforces high default safety limits and supports tighter private-beta overrides through server options or environment variables:

```text
CHROMA_SNAP_PRIVATE_BETA_LIMITS=0              # disable built-in local limit checks
CHROMA_SNAP_MAX_ARTIFACTS_PER_UPLOAD_SESSION=5000
CHROMA_SNAP_MAX_ARTIFACT_BYTES_PER_UPLOAD_SESSION=1073741824
CHROMA_SNAP_MAX_SNAPSHOTS_PER_BUILD=5000
CHROMA_SNAP_MAX_SNAPSHOT_BYTES_PER_BUILD=1073741824
CHROMA_SNAP_MAX_ERRORED_SNAPSHOTS_PER_BUILD=500
CHROMA_SNAP_REPOSITORY_ALLOWLIST=owner/repo,other/repo
CHROMA_SNAP_REPOSITORY_BLOCKLIST=owner/blocked
```

Limit violations return HTTP 429 with code `QUOTA_EXCEEDED` and a details array describing each violation. The checks run during upload-session creation and manifest finalization so oversized builds are rejected before diff work begins.

## Metrics and request logs

The API and worker accept an in-process `metricsSink` for tests and adapters. For local process logging, set:

```text
CHROMA_SNAP_METRICS_STDOUT=1
CHROMA_SNAP_REQUEST_LOGS=1
```

Metrics are emitted as JSON lines with this shape:

```json
{
  "kind": "metric",
  "name": "build.finalized",
  "value": 1,
  "unit": "count",
  "timestamp": "2026-05-15T00:00:00.000Z",
  "labels": {
    "repository": "acme/widgets",
    "project": "storybook",
    "snapshotCount": 42
  }
}
```

Initial metric names include:

- `api.request`
- `upload_session.created`
- `upload_session.declared_artifact_bytes`
- `build.finalized`
- `build.snapshot_artifact_bytes`
- `cleanup.completed`
- `worker.error`
- `worker.diff_completed`
- `worker.snapshots_diffed`

Hosted deployments should route these JSON lines into a real metrics backend. Migration `005_milestone_7_private_beta_hardening.sql` adds `usage_events` for a future durable metrics adapter.

## Cleanup

The API exposes a local cleanup endpoint:

```text
POST /v1/admin/cleanup?kind=artifact,comparison,queue-job&before=<ISO>&limit=<N>&dryRun=true
```

Supported kinds:

- `artifact`: deletes abandoned, expired upload sessions and their uploaded objects. Finalized sessions are protected.
- `comparison`: deletes expired comparison reports when the configured comparison store supports deletion.
- `queue-job`: deletes expired completed or failed queue job records. Pending and processing jobs are protected.

Without `before`, cleanup uses `DEFAULT_RETENTION_POLICY` from `@chroma-snap/shared`: build artifacts and comparisons default to 90 days, queue jobs default to 30 days. With `before`, cleanup deletes eligible unprotected records older than the supplied ISO timestamp.

Worker queue helpers include `createCleanupJobHandler()`, which calls the admin cleanup endpoint from a durable queue job payload. Production queue adapters should schedule artifact, comparison, and queue-job cleanup independently so each kind can be retried safely.

## Worker error boundary

Per-snapshot diff failures now become errored comparisons in the report instead of aborting the entire build. The GitHub Check still fails strictly because errored comparisons are hard failures, but reviewers can see which story/mode failed and continue investigating other comparisons from the same run.
