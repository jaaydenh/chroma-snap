# Changelog

## Milestone 7: private-beta hardening

- Added shared typed error codes and API error responses with request IDs.
- Added API liveness/readiness probes, admin diagnostics, structured request logging hooks, and JSON-line metric hooks.
- Added private-beta upload/session guardrails for repository allow/block lists, artifact counts, artifact bytes, snapshot counts, snapshot bytes, and errored snapshot counts.
- Added local retention cleanup for abandoned upload artifacts, expired comparison reports, and terminal queue job records.
- Added a worker cleanup queue handler and per-snapshot diff error boundary so a single diff failure becomes an errored comparison instead of aborting a whole report.
- Added PostgreSQL migration notes for usage events, private-beta limits, and cleanup run history.
- Added private-beta operations docs, future self-hosting migration notes, and a GitHub Actions private-beta example workflow.
