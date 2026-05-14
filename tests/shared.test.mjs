import test from "node:test";
import assert from "node:assert/strict";
import { configHash, normalizeConfig, snapshotIdentityKey, validateConfig } from "../packages/shared/dist/index.js";

test("config normalization supplies deterministic v1 defaults", () => {
  const config = normalizeConfig({ project: { name: "demo" } });
  assert.equal(config.project.name, "demo");
  assert.equal(config.modes[0].browser, "chromium");
  assert.equal(config.modes[0].viewport.width, 1280);
  assert.equal(config.capture.concurrency, 4);
  assert.equal(config.capture.settleDelayMs, 0);
  assert.equal(config.thresholds.maxDiffPixels, 100);
});

test("config validation rejects unsupported v1 browsers and duplicate modes", () => {
  const validation = validateConfig({
    project: { name: "demo" },
    modes: [
      { name: "default", browser: "chromium", viewport: { width: 100, height: 100 } },
      { name: "default", browser: "chromium", viewport: { width: 100, height: 100 } },
    ],
  });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /Duplicate mode name/);
});

test("config and snapshot identity hashes are stable across key order", () => {
  const a = configHash({ project: { name: "demo" }, modes: [{ name: "default", viewport: { width: 320, height: 480 }, globals: { theme: "dark", locale: "en" } }] });
  const b = configHash({ modes: [{ globals: { locale: "en", theme: "dark" }, viewport: { height: 480, width: 320 }, name: "default" }], project: { name: "demo" } });
  assert.equal(a, b);

  const identityA = snapshotIdentityKey({
    repositoryFullName: "acme/widgets",
    projectName: "storybook",
    storyId: "button--primary",
    browserName: "chromium",
    modeName: "default",
    viewport: { width: 320, height: 480 },
    globals: { locale: "en", theme: "dark" },
    configHash: a,
  });
  const identityB = snapshotIdentityKey({
    repositoryFullName: "acme/widgets",
    projectName: "storybook",
    storyId: "button--primary",
    browserName: "chromium",
    modeName: "default",
    viewport: { height: 480, width: 320 },
    globals: { theme: "dark", locale: "en" },
    configHash: b,
  });
  assert.equal(identityA, identityB);
});
