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

## Environment

```text
CHROMA_SNAP_GITHUB_WEBHOOK_SECRET=...
CHROMA_SNAP_GITHUB_APP_ID=12345
CHROMA_SNAP_GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
CHROMA_SNAP_GITHUB_CHECK_NAME="Chroma Snap Visual Tests"
```

Production deployments still need the later-milestone hardening called out in the README: PostgreSQL adapters, durable queues, required installation checks during upload authentication, and reviewer permission checks for approvals.
