# API migrations

`001_initial_schema.sql` defines the intended PostgreSQL schema for hosted deployments. `002_milestone_3_worker_foundations.sql` adds worker retry scheduling, baseline metadata needed for deleted-story reports, and retention policy configuration. The local MVP does not apply these migrations automatically; it remains file-backed so development and tests run without external services.

Future migration tooling should track applied versions in PostgreSQL and run migrations transactionally before API/worker startup.
