-- Milestone 7 private-beta hardening.
-- Adds durable places for usage metrics, per-repository beta limits, and cleanup job/run history.

CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY,
  repository_id uuid REFERENCES repositories(id) ON DELETE SET NULL,
  build_id uuid REFERENCES builds(id) ON DELETE SET NULL,
  metric_name text NOT NULL,
  metric_value double precision NOT NULL,
  metric_unit text NOT NULL CHECK (metric_unit IN ('count', 'bytes', 'milliseconds')),
  labels_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  emitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_repository_emitted_at
  ON usage_events (repository_id, emitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_build
  ON usage_events (build_id);

CREATE TABLE IF NOT EXISTS private_beta_limits (
  id uuid PRIMARY KEY,
  repository_full_name text UNIQUE,
  max_artifacts_per_upload_session integer,
  max_artifact_bytes_per_upload_session bigint,
  max_snapshots_per_build integer,
  max_snapshot_bytes_per_build bigint,
  max_errored_snapshots_per_build integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cleanup_runs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  scanned_count integer NOT NULL DEFAULT 0,
  deleted_count integer NOT NULL DEFAULT 0,
  freed_bytes bigint NOT NULL DEFAULT 0,
  warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_cleanup_runs_kind_started_at
  ON cleanup_runs (kind, started_at DESC);
