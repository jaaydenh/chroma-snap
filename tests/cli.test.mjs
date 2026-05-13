import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { main } from "../packages/cli/dist/index.js";

async function writePng(path) {
  const png = new PNG({ width: 1, height: 1 });
  png.data[0] = 10;
  png.data[1] = 20;
  png.data[2] = 30;
  png.data[3] = 255;
  await writeFile(path, PNG.sync.write(png));
}

test("CLI capture builds a manifest from existing adapter events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chroma-snap-cli-"));
  const configPath = join(dir, "visual.config.ts");
  const outputDir = join(dir, "out");
  const imagePath = join(dir, "button.png");
  const eventsPath = join(dir, "events.jsonl");
  const manifestPath = join(outputDir, "manifest.json");
  await writePng(imagePath);
  const sharedUrl = pathToFileURL(resolve("packages/shared/dist/index.js")).href;
  await writeFile(
    configPath,
    `import { defineConfig } from ${JSON.stringify(sharedUrl)};\n\nexport default defineConfig({ project: { name: "storybook" }, capture: { outputDir: ${JSON.stringify(outputDir)}, resultsFile: ${JSON.stringify(eventsPath)} } });\n`,
    "utf8",
  );
  await writeFile(eventsPath, `${JSON.stringify({
    version: 1,
    type: "snapshot",
    capturedAt: "2026-05-13T00:00:00.000Z",
    story: { id: "button--primary", title: "Button", name: "Primary" },
    mode: { name: "default", viewport: { width: 1, height: 1, deviceScaleFactor: 1 }, globals: {} },
    browser: { name: "chromium" },
    imagePath,
  })}\n`, "utf8");

  await main(["capture", "--config", configPath, "--events", eventsPath, "--output-dir", outputDir, "--manifest", manifestPath, "--no-run"]);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.project.name, "storybook");
  assert.equal(manifest.snapshots.length, 1);
  assert.equal(manifest.snapshots[0].image.width, 1);
  assert.equal(manifest.snapshots[0].status, "captured");
});
