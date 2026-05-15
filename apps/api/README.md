# @chroma-snap/api

Local-first upload-session API skeleton. It implements health checks, session creation, scoped artifact PUTs, manifest finalization, artifact integrity checks, file-backed build records, queue records, baseline lookup endpoints, comparison report persistence, GitHub webhook ingestion, PR/base metadata storage, and strict check-run creation/update seams.

Milestones 2 through 4 include the PostgreSQL schema contract in `src/schema.ts` plus migrations under `migrations/`; see `../../docs/data-model.md` for entity relationships and invariants.

Production milestones must replace the development storage/auth seams with PostgreSQL persistence, S3-compatible private object storage, durable queues, verified GitHub Actions OIDC, and required GitHub App installation checks on uploads.
