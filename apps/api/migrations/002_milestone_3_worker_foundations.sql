-- Milestone 3 hosted-worker foundations.
-- Adds metadata needed for deleted-snapshot reports, retry scheduling, and retention policy configuration.

ALTER TABLE baselines
  ADD COLUMN IF NOT EXISTS story_json jsonb,
  ADD COLUMN IF NOT EXISTS mode_json jsonb;

ALTER TABLE queue_jobs
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_queue_jobs_next_retry_at ON queue_jobs(status, next_retry_at);

CREATE TABLE IF NOT EXISTS retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  build_artifact_retention_days integer NOT NULL DEFAULT 90 CHECK (build_artifact_retention_days >= 1),
  comparison_retention_days integer NOT NULL DEFAULT 90 CHECK (comparison_retention_days >= 1),
  queue_job_retention_days integer NOT NULL DEFAULT 30 CHECK (queue_job_retention_days >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id)
);
