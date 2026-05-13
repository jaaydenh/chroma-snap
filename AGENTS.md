# Chroma Snap agent notes

This repository is a TypeScript-first monorepo for an Apache-2.0, hosted-first Storybook visual regression gate. Keep v1 scope focused on Storybook 10/Vite, Chromium-only captures, GitHub Actions/GitHub App integration, private artifacts, server-side diffing, and strict review gates.

Run `npm run build` and `npm test` before claiming implementation success. Do not claim production-ready self-hosting or production-grade OIDC verification unless those paths are explicitly implemented and validated.
