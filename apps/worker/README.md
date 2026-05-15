# @chroma-snap/worker

PNG diff worker and local baseline processor. It reads normalized manifests, compares screenshots to canonical base-branch baselines, classifies changed/new/deleted/errored/unchanged snapshots, writes diff images, persists comparison reports, can seed initial base-branch baselines for onboarding, and can reconcile approved PR changes on base-branch confirmation with `--reconcile-approved`. Milestone 6 promotion reconciliation promotes exact SHA matches, retires approved deletions, and writes baseline audit events through the review store.
