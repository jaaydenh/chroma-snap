# API migrations

`001_initial_schema.sql` defines the intended PostgreSQL schema for hosted deployments. `002_milestone_3_worker_foundations.sql` adds worker retry scheduling, baseline metadata needed for deleted-story reports, and retention policy configuration. `003_milestone_4_github_app.sql` adds GitHub App installations, webhook deduplication, PR/base metadata, refs, and check-run tracking. `004_milestone_6_baseline_promotion.sql` adds baseline promotion reconciliation context for approved PR snapshots. The local MVP does not apply these migrations automatically; it remains file-backed so development and tests run without external services.

Future migration tooling should track applied versions in PostgreSQL and run migrations transactionally before API/worker startup.
