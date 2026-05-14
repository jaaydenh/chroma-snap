import { defineConfig } from "@chroma-snap/shared";

export default defineConfig({
  version: 1,
  project: { name: "storybook" },
  storybook: {
    configDir: ".storybook",
    testCommand: "vitest --project storybook",
  },
  modes: [
    {
      name: "default",
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      colorScheme: "light",
      globals: { theme: "light" },
    },
    {
      name: "mobile-dark",
      viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
      colorScheme: "dark",
      globals: { theme: "dark" },
    },
  ],
  capture: {
    settleDelayMs: 0,
    waitForFonts: true,
    pauseAnimations: true,
  },
  thresholds: {
    maxDiffPixels: 100,
    maxDiffPixelRatio: 0.001,
    includeAntiAliasing: false,
  },
  masks: [
    { selector: "[data-visual-mask]", reason: "dynamic timestamps or randomized content" },
  ],
});
