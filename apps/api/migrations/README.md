# API migrations

`001_initial_schema.sql` defines the intended PostgreSQL schema for hosted deployments. The local MVP does not apply this migration automatically; it remains file-backed so development and tests run without external services.

Future migration tooling should track applied versions in PostgreSQL and run migrations transactionally before API/worker startup.
