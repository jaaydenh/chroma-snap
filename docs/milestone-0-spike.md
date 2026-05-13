# Milestone 0: Storybook 10/Vite automatic capture spike

The product plan depends on automatic final-state screenshots without requiring every story to call a helper. This repository implements the spike harness, not a final compatibility claim.

## Implemented spike path

`packages/capture-storybook-vitest` exports:

- `installVitestAutoCapture(options)`: registers a Vitest `afterEach` hook, infers story metadata, waits for document fonts, pauses CSS animations/transitions, takes a screenshot from `@vitest/browser/context`'s `page`, and emits a capture event.
- `createVitestSetupModule(options)`: generates a setup module that can be included from a Storybook/Vitest browser-mode setup file.

`packages/cli` consumes the JSONL capture events, hashes images, records dimensions, calculates a stable snapshot identity, and writes a normalized manifest.

## Wiring example

Add a setup file to the Storybook Vitest browser project:

```ts
import { installVitestAutoCapture } from "@chroma-snap/capture-storybook-vitest";

const mode = JSON.parse(process.env.CHROMA_SNAP_MODE ?? '{"name":"default","viewport":{"width":1280,"height":720}}');

await installVitestAutoCapture({
  outputDir: process.env.CHROMA_SNAP_CAPTURE_OUTPUT_DIR,
  eventsFile: process.env.CHROMA_SNAP_CAPTURE_EVENTS,
  mode,
});
```

Then run:

```bash
CHROMA_SNAP_CAPTURE_OUTPUT_DIR=.chroma-snap/capture \
CHROMA_SNAP_CAPTURE_EVENTS=.chroma-snap/capture/capture-events.jsonl \
CHROMA_SNAP_MODE='{"name":"default","viewport":{"width":1280,"height":720}}' \
vitest --project storybook

chroma-snap capture --no-run
```

## Exit criteria before backend work depends on this adapter

- Simple stories produce screenshots without modifying `.stories.tsx` files.
- Stories with `play` functions are captured after the play function completes.
- Story IDs, titles, names, and import paths are available or reliably inferable.
- Font readiness waits and animation pausing reduce obvious noise.
- Multiple named modes can run without cross-mode artifact collisions.
- Capture failures produce hard-failure events with concise logs.

## Known open questions

- Whether Vitest's browser `page` object exposes a stable screenshot API in all supported Storybook 10/Vite setups.
- Whether the setup hook has enough Storybook metadata for every framework/story shape.
- Whether environment variables are available in the setup module after Vite bundling in every target repo.
- Whether concurrent browser workers isolate page state and artifact names as expected.

If any of these fail in the spike, the capture engine should be revisited before building service features around this adapter.
