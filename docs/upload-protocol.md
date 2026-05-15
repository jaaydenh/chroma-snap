# Upload protocol

The protocol follows the plan's manifest-first upload-session shape while remaining runnable in local development.

## 1. Create an upload session

`POST /v1/upload-sessions`

The CLI sends repository, git, project, config hash, GitHub run metadata, and the list of artifacts it intends to upload. In production this request must include a verified GitHub Actions OIDC bearer token tied to an installed GitHub App.

The API returns:

- `sessionId`
- `buildId`
- `expiresAt`
- scoped `PUT` targets for each artifact

## 2. Upload artifacts

`PUT /v1/upload-sessions/:sessionId/artifacts/:artifactId`

The local API stores files under `.chroma-snap/server/artifacts`. The production adapter will replace this with private S3-compatible object storage and presigned URLs.

## 3. Finalize the manifest

`POST /v1/upload-sessions/:sessionId/finalize`

The CLI sends the normalized manifest. Finalization validates the manifest, writes build metadata, creates a queued Chroma Snap GitHub Check record, and enqueues a diff job record.

## 4. Diff processing

The worker compares captured snapshots to canonical accepted base-branch baselines and writes `comparison-report.json`. Current local classifications are:

- `unchanged`: image hash or diff is within threshold.
- `changed`: baseline exists and pixel diff exceeds threshold.
- `new`: no baseline exists for the story/mode identity.
- `deleted`: a baseline identity is missing from the current manifest.
- `errored`: capture or manifest integrity failed.
- `pending`: reserved for async hosted processing.

## Private-beta guardrails

Milestone 7 applies private-beta limits during session creation and finalization. Upload-session creation can reject oversized artifact declarations before any bytes are uploaded. Finalization can reject manifests with too many snapshots, too many errored snapshots, or too many referenced snapshot bytes before diff jobs are queued. These failures return HTTP 429 with code `QUOTA_EXCEEDED`.

Cleanup for abandoned, unfinalized sessions is available through `POST /v1/admin/cleanup?kind=artifact`. Finalized build artifacts remain protected by default so baseline images are not deleted by the local cleanup path.

## Security note

`apps/api` parses and validates stable GitHub Actions OIDC claims, but it does not implement JWKS signature verification yet. Local development must use `CHROMA_SNAP_DEV_AUTH=1` or explicitly opt into unsigned claim testing. Production must add signature verification and GitHub App installation checks before accepting private screenshots.
