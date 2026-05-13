# @chroma-snap/action

GitHub Action wrapper around the CLI. It runs capture and, by default, uploads the generated manifest and screenshots. Workflows using this action must grant `id-token: write` so the CLI can request a GitHub Actions OIDC token for hosted uploads.
