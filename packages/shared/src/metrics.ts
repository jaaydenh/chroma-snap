import type { BuildManifest } from "./manifest.js";

export type MetricUnit = "count" | "bytes" | "milliseconds";
export type MetricLabelValue = string | number | boolean | null;

export interface MetricEvent {
  kind: "metric";
  name: string;
  value: number;
  unit: MetricUnit;
  timestamp: string;
  labels?: Record<string, MetricLabelValue>;
}

export type MetricSink = (event: MetricEvent) => void | Promise<void>;

export interface BuildUsageSummary {
  snapshotCount: number;
  capturedSnapshotCount: number;
  erroredSnapshotCount: number;
  artifactBytes: number;
  storyCount: number;
  modeCount: number;
}

export function createMetricEvent(input: {
  name: string;
  value: number;
  unit?: MetricUnit;
  timestamp?: string;
  labels?: Record<string, MetricLabelValue | undefined>;
}): MetricEvent {
  return {
    kind: "metric",
    name: input.name,
    value: input.value,
    unit: input.unit ?? "count",
    timestamp: input.timestamp ?? new Date().toISOString(),
    labels: cleanMetricLabels(input.labels),
  };
}

export function metricJsonLine(event: MetricEvent): string {
  return JSON.stringify(event);
}

export function summarizeManifestUsage(manifest: BuildManifest): BuildUsageSummary {
  const storyIds = new Set<string>();
  const modes = new Set<string>();
  let artifactBytes = 0;
  let capturedSnapshotCount = 0;
  let erroredSnapshotCount = 0;

  for (const snapshot of manifest.snapshots) {
    storyIds.add(snapshot.story.id);
    modes.add(snapshot.mode.name);
    if (snapshot.status === "captured") {
      capturedSnapshotCount += 1;
      artifactBytes += snapshot.image?.byteSize ?? 0;
    } else if (snapshot.status === "errored") {
      erroredSnapshotCount += 1;
      artifactBytes += snapshot.logs?.byteSize ?? 0;
    }
  }

  return {
    snapshotCount: manifest.snapshots.length,
    capturedSnapshotCount,
    erroredSnapshotCount,
    artifactBytes,
    storyCount: storyIds.size,
    modeCount: modes.size,
  };
}

function cleanMetricLabels(labels: Record<string, MetricLabelValue | undefined> | undefined): Record<string, MetricLabelValue> | undefined {
  if (!labels) {
    return undefined;
  }
  const cleaned = Object.fromEntries(Object.entries(labels).filter((entry): entry is [string, MetricLabelValue] => entry[1] !== undefined));
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}
