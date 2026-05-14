import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { captureFixtures } from "../packages/capture-fixture/dist/index.js";
import { main } from "../packages/cli/dist/index.js";

async function writePng(path, rgba) {
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = rgba[0];
    png.data[index + 1] = rgba[1];
    png.data[index + 2] = rgba[2];
    png.data[index + 3] = rgba[3];
  }
  await writeFile(path, PNG.sync.write(png));
}

async function writeConfig(path, outputDir, eventsFile) {
  await writeFile(
    path,
    JSON.stringify({
      project: { name: "fixture-project" },
      capture: { outputDir, resultsFile: eventsFile },
      modes: [
        { name: "default", viewport: { width: 1280, height: 720 }, globals: {} },
        { name: "mobile-dark", viewport: { width: 390, height: 844, deviceScaleFactor: 2 }, colorScheme: "dark", globals: { theme: "dark" } },
      ],
    }),
    "utf8",
  );
}

test("fixture adapter emits events that the CLI normalizes into a manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chroma-snap-fixture-"));
  const source = join(dir, "source.png");
  const outputDir = join(dir, "out");
  const eventsFile = join(dir, "events.jsonl");
  const configPath = join(dir, "visual.config.json");
  const manifestPath = join(dir, "manifest.json");
  await writePng(source, [20, 40, 60, 255]);
  await writeConfig(configPath, outputDir, eventsFile);

  await captureFixtures(
    [
      {
        story: { id: "fixture-button--default", title: "Fixture/Button", name: "Default" },
        imagePath: source,
        timings: { captureMs: 2, totalMs: 3 },
      },
    ],
    { outputDir, eventsFile },
    { mode: { name: "default", viewport: { width: 1280, height: 720 }, globals: {} } },
  );

  process.env.CHROMA_SNAP_ADAPTER = "fixture";
  try {
    await main(["capture", "--config", configPath, "--events", eventsFile, "--output-dir", outputDir, "--manifest", manifestPath, "--no-run"]);
  } finally {
    delete process.env.CHROMA_SNAP_ADAPTER;
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.capture.adapter, "fixture");
  assert.equal(manifest.snapshots.length, 1);
  assert.equal(manifest.snapshots[0].story.id, "fixture-button--default");
  assert.equal(manifest.snapshots[0].image.width, 2);
  assert.equal(manifest.snapshots[0].timings.captureMs, 2);
});

test("fixture adapter supports multiple modes without Storybook", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chroma-snap-fixture-modes-"));
  const source = join(dir, "source.png");
  const eventsFile = join(dir, "events.jsonl");
  await writePng(source, [200, 100, 50, 255]);

  const events = await captureFixtures(
    [
      { story: { id: "fixture-card--default" }, imagePath: source, mode: { name: "default", viewport: { width: 1280, height: 720 } } },
      { story: { id: "fixture-card--default" }, imagePath: source, mode: { name: "mobile-dark", viewport: { width: 390, height: 844, deviceScaleFactor: 2 }, colorScheme: "dark", globals: { theme: "dark" } } },
    ],
    { outputDir: join(dir, "out"), eventsFile },
    { mode: { name: "default", viewport: { width: 1280, height: 720 } } },
  );

  assert.equal(events.length, 2);
  assert.equal(events[0].mode.name, "default");
  assert.equal(events[1].mode.name, "mobile-dark");
  assert.equal(events[1].mode.colorScheme, "dark");
  assert.notEqual(events[0].imagePath, events[1].imagePath);
});
