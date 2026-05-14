import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshotFileName, inferStoryMetadata, normalizeMode, safeFileSegment, serializeError } from "../packages/capture-storybook-vitest/dist/index.js";

test("adapter mode normalization preserves capture dimensions", () => {
  const mode = normalizeMode({
    name: "mobile-dark",
    viewport: { width: 390, height: 844, isMobile: true },
    colorScheme: "dark",
    theme: "dark",
    globals: { locale: "en", highContrast: false },
  });
  assert.equal(mode.name, "mobile-dark");
  assert.deepEqual(mode.viewport, { width: 390, height: 844, isMobile: true, deviceScaleFactor: 1 });
  assert.equal(mode.colorScheme, "dark");
  assert.deepEqual(mode.globals, { locale: "en", highContrast: false });
});

test("adapter metadata inference uses Storybook meta when present", () => {
  const story = inferStoryMetadata({
    task: {
      id: "task-fallback",
      name: "Primary",
      suite: { name: "Button" },
      meta: {
        storybook: {
          id: "components-button--primary",
          title: "Components/Button",
          name: "Primary",
          importPath: "./Button.stories.tsx",
          tags: ["dev", "test"],
        },
      },
    },
  });
  assert.equal(story.id, "components-button--primary");
  assert.equal(story.title, "Components/Button");
  assert.equal(story.name, "Primary");
  assert.deepEqual(story.tags, ["dev", "test"]);
});

test("adapter filename helpers are safe and collision resistant", () => {
  assert.equal(safeFileSegment("Components/Button Primary"), "Components-Button-Primary");
  assert.equal(safeFileSegment("////"), "snapshot");
  assert.ok(safeFileSegment("a".repeat(300)).length <= 120);

  const base = {
    capturedAt: "2026-05-13T00:00:00.000Z",
    story: { id: "button--primary" },
    mode: { name: "default", viewport: { width: 1280, height: 720 }, globals: {} },
  };
  assert.match(buildSnapshotFileName(base), /^button--primary__default__[a-f0-9]{10}\.png$/);
  assert.notEqual(buildSnapshotFileName(base), buildSnapshotFileName({ ...base, capturedAt: "2026-05-13T00:00:01.000Z" }));
});

test("adapter error serialization includes timeout context", () => {
  const error = new Error("Timeout waiting for screenshot");
  error.name = "TimeoutError";
  const serialized = serializeError(error, 30000);
  assert.equal(serialized.message, "Timeout waiting for screenshot");
  assert.equal(serialized.timeoutMs, 30000);
  assert.ok(serialized.stack);
});
