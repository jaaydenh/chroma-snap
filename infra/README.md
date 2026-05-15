# Infrastructure notes

The supported v1 product is hosted-first. This directory captures deployment seams without claiming production self-hosting support yet.

Required hosted components for later milestones:

- PostgreSQL for relational metadata.
- S3-compatible private object storage for screenshots, diffs, logs, manifests, and retained baselines.
- Durable queue for diff jobs, GitHub Check updates, cleanup, and baseline promotion reconciliation.
- GitHub App configuration for installation, permissions, checks, and webhooks.
- Observability for API, worker, queue, object storage, and GitHub integration failures.

Milestone 7 adds local health/readiness probes, admin diagnostics, retention cleanup, JSON-line metrics, request logs, and private-beta limits. These are development seams for hosted operations; production deployments still need managed metrics/log shipping, durable cleanup scheduling, and stronger admin auth.

The local MVP currently uses filesystem-backed API storage and JSON baseline records.
