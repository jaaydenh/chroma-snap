# GitHub App and Checks integration

Milestone 4 adds the first hosted-service GitHub App seam while keeping local development file-backed.

## Webhooks

The API accepts GitHub webhooks at either endpoint:

```text
POST /v1/github/webhooks
POST /v1/webhooks/github
```

Configured deployments should set `CHROMA_SNAP_GITHUB_WEBHOOK_SECRET`. The API verifies `x-hub-signature-256`, deduplicates deliveries by `x-github-delivery`, and records processed webhook payloads under the local GitHub store. The supported v1 event set is:

- `installation`: records installation scope and permissions.
- `installation_repositories`: updates repository scope for an installation.
- `pull_request`: records PR number, head SHA/ref, base SHA/ref, sender, and installation ID.
- `push`: records branch ref metadata for base-branch lineage.

## Check runs

Finalizing an upload session creates a queued Chroma Snap check record for the build. Saving a comparison report updates the check record to `completed` and applies strict visual-gate conclusions:

- `success`: no blocking visual differences or errors.
- `action_required`: changed, new, or deleted snapshots require review.
- `failure`: capture errors or failed comparison conclusions.
- `neutral`: pending comparison state remains.

If the API is started with `CHROMA_SNAP_GITHUB_APP_ID` and `CHROMA_SNAP_GITHUB_PRIVATE_KEY`, it creates a GitHub App client that can publish those check runs through the GitHub Checks API. Without those values, the local file-backed check records still exercise the protocol.

## Review decisions and signed artifacts

Milestone 5 adds local review endpoints used by the hosted review surface:

```text
GET  /v1/reports
GET  /v1/builds/:buildId/review
GET  /v1/builds/:buildId/decisions
POST /v1/builds/:buildId/decisions
GET  /v1/builds/:buildId/audit-events
GET  /v1/builds/:buildId/artifact-url?objectKey=...
GET  /v1/artifacts?objectKey=...&expiresAt=...&buildId=...&signature=...
```

`POST /decisions` accepts `approved` or `rejected` decisions for changed, new, or deleted snapshots. Capture errors remain hard failures and are not approvable. In local development with `CHROMA_SNAP_DEV_AUTH=1` or `allowDevAuth`, reviewer identity and repository permission can be supplied with `x-chroma-snap-github-login`, `x-chroma-snap-github-user-id`, and `x-chroma-snap-repository-permission` headers, or form fields from the local HTML review UI. Non-dev deployments must inject a GitHub permission verifier so the API can confirm the reviewer has `write`, `maintain`, or `admin` permission before changing Check state.

Signed artifact URLs use `CHROMA_SNAP_ARTIFACT_SIGNING_SECRET` and short expirations. The signing endpoint only issues URLs for object keys referenced by the build's comparison report; the artifact endpoint verifies the HMAC signature before reading from private storage.

## Environment

```text
CHROMA_SNAP_GITHUB_WEBHOOK_SECRET=...
CHROMA_SNAP_GITHUB_APP_ID=12345
CHROMA_SNAP_GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
CHROMA_SNAP_ARTIFACT_SIGNING_SECRET=...
CHROMA_SNAP_GITHUB_CHECK_NAME="Chroma Snap Visual Tests"
CHROMA_SNAP_ADMIN_SECRET="operator-cleanup-secret"
CHROMA_SNAP_METRICS_STDOUT=1
CHROMA_SNAP_REQUEST_LOGS=1
```

Milestone 7 adds `/health`, `/ready`, `/v1/admin/diagnostics`, and `/v1/admin/cleanup` for private-beta operations. Production deployments still need the later hardening called out in the README: PostgreSQL adapters, durable queues, required installation checks during upload authentication, and full OAuth session handling for the hosted review UI.
