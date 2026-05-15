# Review workflow and baseline promotion

Chroma Snap's v1 review model is a strict PR visual gate with canonical base-branch baselines.

## PR build flow

1. The GitHub Action runs capture in CI.
2. The CLI uploads screenshots, concise logs, and a normalized manifest.
3. The service diff worker compares each current snapshot to the accepted base-branch baseline for the same story/mode identity.
4. The report classifies snapshots as:
   - `unchanged`
   - `changed`
   - `new`
   - `deleted`
   - `errored`
   - `pending`
5. `changed`, `new`, and `deleted` snapshots require authorized review.
6. `errored` snapshots are hard failures and cannot be approved as visual diffs.

## Decisions

Authorized GitHub users with `write`, `maintain`, or `admin` repository permission can create decisions:

- `approved`: visual change is intentional for this PR/head SHA.
- `rejected`: visual change is not acceptable and must be reworked.

Every decision must create an audit event with user, repository permission, build, snapshot identity, previous state, new state, and timestamp.

## Check status semantics

- Processing/uploading: pending or in progress.
- No diffs and no errors: success.
- All required diffs approved: success.
- Unreviewed required diffs: action required.
- Rejected diff, capture error, diff error, missing artifact, invalid manifest: failure.

The GitHub Action upload step should not fail merely because visual changes exist. The GitHub Check is the canonical gate.

## Baseline promotion

PR approval does **not** immediately mutate canonical baselines. Approved PR snapshots promote only after:

1. the approved commit lands on the base branch; and
2. a base-branch run captures the same story/mode snapshot content; and
3. the service reconciles the base-branch snapshot with the prior PR approval.

This prevents unmerged PRs or stale approvals from changing the baseline seen by other branches.

## Local MVP behavior

The current worker can seed base-branch baselines with `--seed-baselines`, classify PR-like manifests against those baselines, persist comparison reports, and use API-backed baseline/comparison stores for hosted worker handoff. The API records GitHub App webhooks, PR/base refs, strict Check Run state, review decisions, and audit events locally, and can publish updated GitHub Checks when a GitHub App publisher is configured. Review decisions require `write`, `maintain`, or `admin` repository permission through the local dev headers or an injected GitHub permission verifier. Baseline promotion reconciliation remains Milestone 6 work.
