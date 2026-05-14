# @chroma-snap/api

Local-first upload-session API skeleton. It implements health checks, session creation, scoped artifact PUTs, manifest finalization, artifact integrity checks, file-backed build records, and queue records.

Milestone 2 now includes the PostgreSQL schema contract in `src/schema.ts` and `migrations/001_initial_schema.sql`; see `../../docs/data-model.md` for entity relationships and invariants.

Production milestones must replace the development storage/auth seams with PostgreSQL persistence, S3-compatible private object storage, durable queues, verified GitHub Actions OIDC, and GitHub App installation checks.
