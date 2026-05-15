-- Milestone 6 baseline promotion reconciliation metadata.
-- Approved PR snapshots become canonical baselines only after a base-branch run confirms them.

ALTER TABLE baselines
  ADD COLUMN IF NOT EXISTS promotion_context_json jsonb;

CREATE INDEX IF NOT EXISTS idx_baselines_promotion_context_source
  ON baselines ((promotion_context_json->>'source'))
  WHERE promotion_context_json IS NOT NULL;
