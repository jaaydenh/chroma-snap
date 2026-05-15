# @chroma-snap/worker

PNG diff worker and local baseline processor. It reads normalized manifests, compares screenshots to canonical base-branch baselines, classifies changed/new/deleted/errored/unchanged snapshots, writes diff images, persists comparison reports, and can seed initial base-branch baselines for onboarding. Milestone 3 also includes API-backed store adapters plus an idempotent queue retry primitive for hosted worker handoff.
