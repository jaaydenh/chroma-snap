#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { captureFixtures } from "../packages/capture-fixture/dist/index.js";
import { main as runCli } from "../packages/cli/dist/index.js";
import { assertValidManifest } from "../packages/shared/dist/index.js";

const root = resolve(".chroma-snap/dogfood");
const fixturesDir = join(root, "fixtures");
const outputDir = join(root, "capture");
const eventsFile = join(outputDir, "events.jsonl");
const configPath = join(root, "visual.config.json");
const manifestPath = join(outputDir, "manifest.json");

await mkdir(fixturesDir, { recursive: true });
await writeSolidPng(join(fixturesDir, "report-empty.png"), [20, 40, 70, 255]);
await writeSolidPng(join(fixturesDir, "report-changed.png"), [120, 40, 170, 255]);
await writeFile(
  configPath,
  `${JSON.stringify(
    {
      project: { name: "chroma-snap-dogfood" },
      capture: { outputDir, resultsFile: eventsFile },
      modes: [{ name: "default", viewport: { width: 1280, height: 720 }, globals: {} }],
    },
    null,
    2,
  )}\n`,
  "utf8",
);

await captureFixtures(
  [
    { story: { id: "report--empty", title: "Report", name: "Empty" }, imagePath: join(fixturesDir, "report-empty.png") },
    { story: { id: "report--changed", title: "Report", name: "Changed" }, imagePath: join(fixturesDir, "report-changed.png") },
  ],
  { outputDir, eventsFile },
  { mode: { name: "default", viewport: { width: 1280, height: 720 }, globals: {} } },
);

process.env.CHROMA_SNAP_ADAPTER = "fixture";
await runCli(["capture", "--config", configPath, "--events", eventsFile, "--output-dir", outputDir, "--manifest", manifestPath, "--no-run"]);
delete process.env.CHROMA_SNAP_ADAPTER;

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assertValidManifest(manifest);
console.log(`Dogfood fixture manifest is valid: ${manifestPath}`);

async function writeSolidPng(path, rgba) {
  const png = new PNG({ width: 4, height: 4 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = rgba[0];
    png.data[index + 1] = rgba[1];
    png.data[index + 2] = rgba[2];
    png.data[index + 3] = rgba[3];
  }
  await writeFile(path, PNG.sync.write(png));
}
