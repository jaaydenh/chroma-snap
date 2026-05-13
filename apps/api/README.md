# @chroma-snap/api

Local-first upload-session API skeleton. It implements health checks, session creation, scoped artifact PUTs, manifest finalization, file-backed build records, and queue records. Production milestones must replace the development storage/auth seams with PostgreSQL, private object storage, durable queues, verified GitHub Actions OIDC, and GitHub App installation checks.
