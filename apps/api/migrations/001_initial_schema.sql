-- Chroma Snap initial hosted-service schema.
-- Applies to PostgreSQL. Local development still uses file-backed storage.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('github')),
  owner text NOT NULL,
  name text NOT NULL,
  full_name text NOT NULL,
  installation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, owner, name)
);

CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY,
  build_id uuid NOT NULL UNIQUE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  config_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  finalized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_sessions_repository_finalized_created_idx ON upload_sessions(repository_id, finalized, created_at);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('screenshot', 'manifest', 'log', 'diff')),
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  sha256 char(64),
  byte_size bigint,
  width integer,
  height integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, artifact_id)
);
CREATE INDEX artifacts_session_idx ON artifacts(session_id);
CREATE INDEX artifacts_sha256_idx ON artifacts(sha256);

CREATE TABLE builds (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE RESTRICT,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  project_name text NOT NULL,
  branch text NOT NULL,
  commit_sha text NOT NULL,
  base_branch text,
  merge_base_sha text,
  pull_request_number integer,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  report_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz
);
CREATE INDEX builds_repository_branch_created_idx ON builds(repository_id, branch, created_at);
CREATE INDEX builds_repository_status_idx ON builds(repository_id, status);
CREATE INDEX builds_commit_sha_idx ON builds(commit_sha);

CREATE TABLE baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  project_name text NOT NULL,
  branch text NOT NULL,
  identity_key char(40) NOT NULL,
  build_id uuid NOT NULL REFERENCES builds(id) ON DELETE RESTRICT,
  object_key text,
  sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, project_name, branch, identity_key)
);
CREATE INDEX baselines_repository_project_branch_idx ON baselines(repository_id, project_name, branch);
CREATE INDEX baselines_build_idx ON baselines(build_id);

CREATE TABLE comparison_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id uuid NOT NULL UNIQUE REFERENCES builds(id) ON DELETE CASCADE,
  generated_at timestamptz NOT NULL,
  base_branch text NOT NULL,
  head_branch text NOT NULL,
  check_conclusion text NOT NULL CHECK (check_conclusion IN ('success', 'failure', 'action_required', 'neutral')),
  summary_json jsonb NOT NULL,
  warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE snapshot_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES comparison_reports(id) ON DELETE CASCADE,
  identity_key char(40) NOT NULL,
  status text NOT NULL CHECK (status IN ('unchanged', 'changed', 'new', 'deleted', 'errored', 'pending')),
  current_snapshot_json jsonb,
  baseline_id uuid REFERENCES baselines(id) ON DELETE SET NULL,
  diff_json jsonb,
  requires_approval boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX snapshot_comparisons_report_status_idx ON snapshot_comparisons(report_id, status);
CREATE INDEX snapshot_comparisons_baseline_idx ON snapshot_comparisons(baseline_id);

CREATE TABLE review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id uuid NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  identity_key char(40) NOT NULL,
  state text NOT NULL CHECK (state IN ('approved', 'rejected')),
  github_user_login text NOT NULL,
  github_user_id bigint,
  repository_permission text NOT NULL CHECK (repository_permission IN ('write', 'maintain', 'admin')),
  previous_state text CHECK (previous_state IN ('approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_decisions_build_identity_idx ON review_decisions(build_id, identity_key, created_at);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  actor_github_login text,
  event_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_repository_created_idx ON audit_events(repository_id, created_at);

CREATE TABLE queue_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  build_id uuid REFERENCES builds(id) ON DELETE CASCADE,
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text
);
CREATE INDEX queue_jobs_status_created_idx ON queue_jobs(status, created_at);
CREATE INDEX queue_jobs_type_status_idx ON queue_jobs(type, status);

COMMIT;
