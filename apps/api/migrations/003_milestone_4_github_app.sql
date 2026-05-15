-- Milestone 4 GitHub App, webhook, PR metadata, and strict Checks foundations.

CREATE TABLE IF NOT EXISTS github_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id integer,
  installation_id bigint NOT NULL UNIQUE,
  account_login text,
  permissions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  repositories_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  suspended_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_delivery_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  action text,
  repository_full_name text,
  installation_id bigint,
  payload_json jsonb NOT NULL,
  processed boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed ON webhook_events(processed, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_repository ON webhook_events(repository_full_name, received_at);

CREATE TABLE IF NOT EXISTS pull_request_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_full_name text NOT NULL,
  pull_request_number integer NOT NULL,
  action text NOT NULL,
  title text,
  state text,
  merged boolean,
  head_ref text NOT NULL,
  head_sha text NOT NULL,
  base_ref text NOT NULL,
  base_sha text,
  merge_commit_sha text,
  sender_login text,
  installation_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(repository_full_name, pull_request_number)
);

CREATE TABLE IF NOT EXISTS github_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_full_name text NOT NULL,
  ref text NOT NULL,
  sha text NOT NULL,
  before_sha text,
  pusher text,
  installation_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(repository_full_name, ref)
);

CREATE TABLE IF NOT EXISTS check_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id uuid NOT NULL UNIQUE REFERENCES builds(id) ON DELETE CASCADE,
  repository_full_name text NOT NULL,
  head_sha text NOT NULL,
  installation_id bigint,
  github_check_run_id bigint,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'in_progress', 'completed')),
  conclusion text CHECK (conclusion IN ('success', 'failure', 'action_required', 'neutral')),
  details_url text,
  output_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_check_runs_repository_updated ON check_runs(repository_full_name, updated_at);
