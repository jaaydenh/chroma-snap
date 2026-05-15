# @chroma-snap/api

Local-first upload-session API skeleton. It implements health checks, session creation, scoped artifact PUTs, manifest finalization, artifact integrity checks, file-backed build records, queue records, baseline lookup endpoints, and comparison report persistence.

Milestones 2 and 3 include the PostgreSQL schema contract in `src/schema.ts` plus migrations under `migrations/`; see `../../docs/data-model.md` for entity relationships and invariants.

Production milestones must replace the development storage/auth seams with PostgreSQL persistence, S3-compatible private object storage, durable queues, verified GitHub Actions OIDC, and GitHub App installation checks.
