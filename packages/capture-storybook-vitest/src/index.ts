import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Buffer } from "node:buffer";
import type { BrowserMetadata, SnapshotModeMetadata, StoryMetadata } from "@chroma-snap/shared";
import type { ModeConfig } from "@chroma-snap/shared";

export interface VitestAutoCaptureOptions {
  outputDir?: string;
  eventsFile?: string;
  collectorUrl?: string;
  mode?: ModeConfig;
  waitForFonts?: boolean;
  pauseAnimations?: boolean;
  timeoutMs?: number;
}

export interface CaptureEventBase {
  version: 1;
  capturedAt: string;
  story: StoryMetadata;
  mode: SnapshotModeMetadata;
  browser: BrowserMetadata;
  timings?: {
    captureMs?: number;
    totalMs?: number;
  };
}

export interface SnapshotCaptureEvent extends CaptureEventBase {
  type: "snapshot";
  imagePath?: string;
  imageBase64?: string;
  imageSha256?: string;
}

export interface ErrorCaptureEvent extends CaptureEventBase {
  type: "error";
  error: {
    message: string;
    stack?: string;
    code?: string;
  };
}

export type CaptureEvent = SnapshotCaptureEvent | ErrorCaptureEvent;

const DEFAULT_MODE: ModeConfig = {
  name: "default",
  browser: "chromium",
  viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  colorScheme: "light",
  globals: {},
};

export function createVitestSetupModule(options: VitestAutoCaptureOptions = {}): string {
  const serialized = JSON.stringify(options, null, 2);
  return `import { installVitestAutoCapture } from "@chroma-snap/capture-storybook-vitest";\n\nawait installVitestAutoCapture(${serialized});\n`;
}

export async function installVitestAutoCapture(options: VitestAutoCaptureOptions = {}): Promise<void> {
  const vitest = await import("vitest");
  const browserContext = await import("@vitest/browser/context");
  const page = (browserContext as { page?: unknown }).page;
  const mode = normalizeMode(options.mode ?? DEFAULT_MODE);

  vitest.afterEach(async (context?: unknown) => {
    const startedAt = Date.now();
    const story = inferStoryMetadata(context, vitest.expect?.getState?.());
    const baseEvent = {
      version: 1 as const,
      capturedAt: new Date().toISOString(),
      story,
      mode,
      browser: { name: "chromium" as const },
    };

    try {
      await preparePage(page, options);
      const screenshot = await takeScreenshot(page, options.timeoutMs ?? 30_000);
      const event = await persistScreenshot(screenshot, baseEvent, options, startedAt);
      await emitEvent(event, options);
    } catch (error) {
      const event: ErrorCaptureEvent = {
        ...baseEvent,
        type: "error",
        error: serializeError(error),
        timings: { totalMs: Date.now() - startedAt },
      };
      await emitEvent(event, options);
      throw error;
    }
  });
}

function normalizeMode(mode: ModeConfig): SnapshotModeMetadata {
  return {
    name: mode.name,
    viewport: { deviceScaleFactor: 1, ...mode.viewport },
    colorScheme: mode.colorScheme,
    theme: mode.theme,
    globals: mode.globals ?? {},
  };
}

export function inferStoryMetadata(context?: unknown, expectState?: Record<string, unknown>): StoryMetadata {
  const task = (context as { task?: unknown } | undefined)?.task as Record<string, unknown> | undefined;
  const meta = (task?.meta ?? {}) as Record<string, unknown>;
  const storybookMeta = (meta.storybook ?? meta.story ?? {}) as Record<string, unknown>;
  const rawName = [task?.suite ? String((task.suite as { name?: unknown }).name ?? "") : "", task?.name ? String(task.name) : ""]
    .filter(Boolean)
    .join(" ")
    .trim();
  const fallbackName = rawName || String(expectState?.currentTestName ?? "story");
  const explicitId = firstString(storybookMeta.id, meta.storyId, meta.storybookStoryId, task?.id);

  return {
    id: explicitId ?? slugifyStoryId(fallbackName),
    title: firstString(storybookMeta.title, meta.title),
    name: firstString(storybookMeta.name, meta.name, task?.name) ?? fallbackName,
    exportName: firstString(storybookMeta.exportName, meta.exportName),
    importPath: firstString(storybookMeta.importPath, meta.importPath, task?.file ? (task.file as { filepath?: unknown }).filepath : undefined),
    componentName: firstString(storybookMeta.componentName, meta.componentName),
    tags: Array.isArray(storybookMeta.tags) ? storybookMeta.tags.map(String) : undefined,
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function slugifyStoryId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "story";
}

async function preparePage(page: unknown, options: VitestAutoCaptureOptions): Promise<void> {
  const maybePage = page as { evaluate?: (fn: (input: { waitForFonts: boolean; pauseAnimations: boolean }) => unknown, input: { waitForFonts: boolean; pauseAnimations: boolean }) => Promise<unknown> };
  if (typeof maybePage?.evaluate !== "function") {
    return;
  }

  await maybePage.evaluate(
    async ({ waitForFonts, pauseAnimations }) => {
      if (pauseAnimations && !document.getElementById("chroma-snap-disable-animations")) {
        const style = document.createElement("style");
        style.id = "chroma-snap-disable-animations";
        style.textContent = `*, *::before, *::after { animation-delay: 0s !important; animation-duration: 0s !important; animation-play-state: paused !important; transition-delay: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }`;
        document.head.appendChild(style);
      }
      if (waitForFonts && "fonts" in document) {
        await (document as Document & { fonts: { ready: Promise<unknown> } }).fonts.ready;
      }
    },
    { waitForFonts: options.waitForFonts ?? true, pauseAnimations: options.pauseAnimations ?? true },
  );
}

async function takeScreenshot(page: unknown, timeoutMs: number): Promise<Uint8Array> {
  const maybePage = page as { screenshot?: (options?: Record<string, unknown>) => Promise<unknown> };
  if (typeof maybePage?.screenshot !== "function") {
    throw new Error("Vitest browser page does not expose a screenshot() function. The adapter spike must verify a supported screenshot API before service work depends on it.");
  }

  const result = await maybePage.screenshot({ timeout: timeoutMs });
  if (result instanceof Uint8Array) {
    return result;
  }
  if (typeof result === "string") {
    return Buffer.from(result, "base64");
  }
  if (result && typeof result === "object" && "base64" in result && typeof (result as { base64: unknown }).base64 === "string") {
    return Buffer.from((result as { base64: string }).base64, "base64");
  }
  throw new Error("Unsupported screenshot result returned by Vitest browser page.");
}

async function persistScreenshot(
  screenshot: Uint8Array,
  baseEvent: Omit<CaptureEventBase, "type">,
  options: VitestAutoCaptureOptions,
  startedAt: number,
): Promise<SnapshotCaptureEvent> {
  const event: SnapshotCaptureEvent = {
    ...baseEvent,
    type: "snapshot",
    imageBase64: Buffer.from(screenshot).toString("base64"),
    timings: { captureMs: Date.now() - startedAt, totalMs: Date.now() - startedAt },
  };

  if (options.outputDir) {
    const fileName = `${safeFileSegment(baseEvent.story.id)}__${safeFileSegment(baseEvent.mode.name)}.png`;
    const imagePath = resolve(options.outputDir, fileName);
    await mkdir(dirname(imagePath), { recursive: true });
    await writeFile(imagePath, screenshot);
    event.imagePath = imagePath;
    delete event.imageBase64;
  }

  return event;
}

async function emitEvent(event: CaptureEvent, options: VitestAutoCaptureOptions): Promise<void> {
  if (options.collectorUrl) {
    const response = await fetch(options.collectorUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!response.ok) {
      throw new Error(`Chroma Snap collector rejected capture event with HTTP ${response.status}.`);
    }
    return;
  }

  if (!options.eventsFile) {
    return;
  }

  await mkdir(dirname(options.eventsFile), { recursive: true });
  await appendFile(options.eventsFile, `${JSON.stringify(event)}\n`, "utf8");
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "snapshot";
}

function serializeError(error: unknown): { message: string; stack?: string; code?: string } {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: string };
    return { message: error.message, stack: error.stack, code: withCode.code };
  }
  return { message: String(error) };
}
