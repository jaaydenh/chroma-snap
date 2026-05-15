# @chroma-snap/api

Local-first upload-session API skeleton. It implements health/readiness checks, request IDs, typed errors, session creation, scoped artifact PUTs, manifest finalization, private-beta limit checks, artifact integrity checks, file-backed build records, queue records, baseline lookup endpoints, comparison report persistence, GitHub webhook ingestion, PR/base metadata storage, strict check-run creation/update seams, diagnostics, cleanup, and metrics hooks.

Milestones 2 through 7 include the PostgreSQL schema contract in `src/schema.ts` plus migrations under `migrations/`; see `../../docs/data-model.md` for entity relationships and invariants.

Production milestones must replace the development storage/auth seams with PostgreSQL persistence, S3-compatible private object storage, durable queues, verified GitHub Actions OIDC, and required GitHub App installation checks on uploads.
