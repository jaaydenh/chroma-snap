# Parallel dogfood rollout

Milestone 6 keeps Chroma Snap in a parallel, non-replacing dogfood posture. The goal is to prove base-branch promotion semantics without disrupting the current Chromatic gate in the pilot repository.

## Pilot workflow

1. Keep the existing Chromatic workflow enabled and required.
2. Add the Chroma Snap GitHub Action as a separate non-required check at first.
3. Seed `main` baselines with an explicit base-branch run:

   ```bash
   node apps/worker/dist/index.js \
     --manifest .chroma-snap/capture/manifest.json \
     --baseline-file .chroma-snap/baselines.json \
     --seed-baselines
   ```

4. On PR runs, capture and upload normally. Reviewers approve or reject visual changes in Chroma Snap, but those decisions do not mutate baselines.
5. After a PR lands on `main`, run the base-branch workflow with approved reconciliation enabled:

   ```bash
   node apps/worker/dist/index.js \
     --manifest .chroma-snap/capture/manifest.json \
     --baseline-file .chroma-snap/baselines.json \
     --comparison-file .chroma-snap/comparisons.json \
     --review-file .chroma-snap/reviews.json \
     --reconcile-approved
   ```

6. Compare Chroma Snap's changed/new/deleted counts and promoted/retired baseline audit events against Chromatic's result before making Chroma Snap required.

## Acceptance signals

- Base-branch seed runs produce stable baselines for the expected Storybook 10/Vite stories and modes.
- PR approvals make only that PR check pass; they do not change canonical baselines.
- Base-branch confirmation promotes approved changed/new snapshots only when the image SHA matches the approved PR snapshot.
- Approved deletions retire baselines only after the base branch confirms the story or mode is absent.
- Mismatches stay action-required and create `baseline.promotion_mismatch` audit events for investigation.

## Non-goals for this milestone

This is not a replacement rollout. The existing Chromatic workflow should remain enabled until private beta hardening covers hosted deployment, observability, cleanup jobs, and operational support.
