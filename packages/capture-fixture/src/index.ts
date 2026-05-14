import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { hashObject, type ModeConfig, type SnapshotModeMetadata, type StoryMetadata } from "@chroma-snap/shared";

export interface FixtureAdapterOptions {
  outputDir: string;
  eventsFile: string;
}

export interface FixtureCaptureSnapshot {
  story: StoryMetadata;
  imagePath?: string;
  mode?: ModeConfig;
  error?: {
    message: string;
    stack?: string;
    code?: string;
    timeoutMs?: number;
    logExcerpt?: string;
  };
  timings?: {
    prepareMs?: number;
    captureMs?: number;
    totalMs?: number;
  };
}

export interface FixtureCaptureConfig {
  mode: ModeConfig;
}

export interface FixtureSnapshotEvent {
  version: 1;
  type: "snapshot" | "error";
  capturedAt: string;
  story: StoryMetadata;
  mode: SnapshotModeMetadata;
  browser: { name: "chromium" };
  imagePath?: string;
  error?: FixtureCaptureSnapshot["error"];
  timings?: FixtureCaptureSnapshot["timings"];
}

export async function captureFixtures(
  snapshots: FixtureCaptureSnapshot[],
  options: FixtureAdapterOptions,
  config: FixtureCaptureConfig,
): Promise<FixtureSnapshotEvent[]> {
  await mkdir(options.outputDir, { recursive: true });
  await mkdir(dirname(options.eventsFile), { recursive: true });

  const events: FixtureSnapshotEvent[] = [];
  for (const snapshot of snapshots) {
    const mode = normalizeFixtureMode(snapshot.mode ?? config.mode);
    const capturedAt = new Date().toISOString();
    const eventBase = {
      version: 1 as const,
      capturedAt,
      story: snapshot.story,
      mode,
      browser: { name: "chromium" as const },
      timings: snapshot.timings,
    };

    if (snapshot.error) {
      events.push({ ...eventBase, type: "error", error: snapshot.error });
      continue;
    }

    if (!snapshot.imagePath) {
      throw new Error(`Fixture snapshot '${snapshot.story.id}' must include imagePath or error.`);
    }

    const sourcePath = resolve(snapshot.imagePath);
    await stat(sourcePath);
    const targetPath = resolve(options.outputDir, fixtureFileName(snapshot.story.id, mode.name, capturedAt, sourcePath));
    await copyFile(sourcePath, targetPath);
    events.push({ ...eventBase, type: "snapshot", imagePath: targetPath });
  }

  await writeFile(options.eventsFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  return events;
}

export function normalizeFixtureMode(mode: ModeConfig): SnapshotModeMetadata {
  return {
    name: mode.name,
    viewport: { deviceScaleFactor: 1, ...mode.viewport },
    colorScheme: mode.colorScheme,
    theme: mode.theme,
    globals: mode.globals ?? {},
  };
}

function fixtureFileName(storyId: string, modeName: string, capturedAt: string, sourcePath: string): string {
  const suffix = hashObject({ storyId, modeName, capturedAt, sourcePath }).slice(0, 10);
  return `${safeSegment(storyId)}__${safeSegment(modeName)}__${suffix}${extensionFor(sourcePath)}`;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "snapshot";
}

function extensionFor(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : ".png";
}
