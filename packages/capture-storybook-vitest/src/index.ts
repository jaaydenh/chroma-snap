import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import { hashObject, sha256, type BrowserName, type ColorScheme, type ModeConfig, type ViewportConfig } from "@chroma-snap/shared";
import type { BrowserMetadata, CaptureError, SnapshotModeMetadata, StoryMetadata } from "@chroma-snap/shared";

export interface VitestAutoCaptureOptions {
  outputDir?: string;
  eventsFile?: string;
  collectorUrl?: string;
  mode?: ModeConfig;
  waitForFonts?: boolean;
  pauseAnimations?: boolean;
  timeoutMs?: number;
  /** Extra post-render settle time before screenshotting. Keep default at 0 for speed. */
  settleDelayMs?: number;
}

export interface CaptureTimings {
  prepareMs?: number;
  captureMs?: number;
  totalMs?: number;
}

export interface CaptureEventBase {
  version: 1;
  capturedAt: string;
  story: StoryMetadata;
  mode: SnapshotModeMetadata;
  browser: BrowserMetadata;
  timings?: CaptureTimings;
}

export interface SnapshotCaptureEvent extends CaptureEventBase {
  type: "snapshot";
  imagePath?: string;
  imageBase64?: string;
  imageSha256?: string;
}

export interface ErrorCaptureEvent extends CaptureEventBase {
  type: "error";
  error: CaptureError;
}

export type CaptureEvent = SnapshotCaptureEvent | ErrorCaptureEvent;

interface BrowserPageLike {
  evaluate?: <Input>(fn: (input: Input) => unknown, input: Input) => Promise<unknown>;
  screenshot?: (options?: Record<string, unknown>) => Promise<unknown>;
  viewport?: (width: number, height: number) => Promise<unknown> | unknown;
  setViewportSize?: (viewport: { width: number; height: number }) => Promise<unknown> | unknown;
  emulateMedia?: (options: { colorScheme?: ColorScheme }) => Promise<unknown> | unknown;
}

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

  // Apply mode before each story test so viewport, media preferences, and globals are
  // present before the Storybook/Vitest test body renders and runs play functions.
  vitest.beforeEach(async () => {
    await applyModeToPage(page, mode);
  });

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
    let prepareMs: number | undefined;

    try {
      const prepareStartedAt = Date.now();
      await preparePage(page, options, mode);
      await delay(options.settleDelayMs ?? 0);
      prepareMs = Date.now() - prepareStartedAt;

      const captureStartedAt = Date.now();
      const screenshot = await takeScreenshot(page, options.timeoutMs ?? 30_000);
      const captureMs = Date.now() - captureStartedAt;

      const event = await persistScreenshot(screenshot, baseEvent, options, {
        prepareMs,
        captureMs,
        totalMs: Date.now() - startedAt,
      });
      await emitEvent(event, options);
    } catch (error) {
      const event: ErrorCaptureEvent = {
        ...baseEvent,
        type: "error",
        error: serializeError(error, options.timeoutMs ?? 30_000),
        timings: { prepareMs, totalMs: Date.now() - startedAt },
      };
      await emitEvent(event, options);
      throw error;
    }
  });
}

export function normalizeMode(mode: ModeConfig): SnapshotModeMetadata {
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
  const storybookMeta = (meta.storybook ?? meta.story ?? meta.__storybook ?? {}) as Record<string, unknown>;
  const file = task?.file as { filepath?: unknown; name?: unknown } | undefined;
  const suite = task?.suite as { name?: unknown } | undefined;
  const rawName = [suite?.name ? String(suite.name) : "", task?.name ? String(task.name) : ""]
    .filter(Boolean)
    .join(" ")
    .trim();
  const fallbackName = rawName || String(expectState?.currentTestName ?? "story");
  const explicitId = firstString(storybookMeta.id, meta.storyId, meta.storybookStoryId, meta.id, task?.id);

  return {
    id: explicitId ?? slugifyStoryId(fallbackName),
    title: firstString(storybookMeta.title, meta.title, suite?.name),
    name: firstString(storybookMeta.name, meta.name, task?.name) ?? fallbackName,
    exportName: firstString(storybookMeta.exportName, meta.exportName),
    importPath: firstString(storybookMeta.importPath, meta.importPath, file?.filepath, file?.name),
    componentName: firstString(storybookMeta.componentName, meta.componentName),
    tags: Array.isArray(storybookMeta.tags) ? storybookMeta.tags.map(String) : undefined,
  };
}

async function applyModeToPage(page: unknown, mode: SnapshotModeMetadata): Promise<void> {
  const maybePage = page as BrowserPageLike | undefined;
  if (!maybePage) {
    return;
  }

  const viewport = {
    width: mode.viewport.width,
    height: mode.viewport.height,
  };

  if (typeof maybePage.setViewportSize === "function") {
    await maybePage.setViewportSize(viewport);
  } else if (typeof maybePage.viewport === "function") {
    await maybePage.viewport(viewport.width, viewport.height);
  }

  if (mode.colorScheme && typeof maybePage.emulateMedia === "function") {
    await maybePage.emulateMedia({ colorScheme: mode.colorScheme });
  }

  if (typeof maybePage.evaluate === "function") {
    await maybePage.evaluate(
      ({ modeName, viewport: pageViewport, colorScheme, theme, globals }) => {
        const globalWindow = window as Window & {
          __CHROMA_SNAP_MODE__?: unknown;
          __CHROMA_SNAP_GLOBALS__?: unknown;
          __STORYBOOK_GLOBALS__?: unknown;
          __STORYBOOK_ADDONS_CHANNEL__?: { emit?: (eventName: string, payload: unknown) => void };
        };
        globalWindow.__CHROMA_SNAP_MODE__ = { name: modeName, viewport: pageViewport, colorScheme, theme, globals };
        globalWindow.__CHROMA_SNAP_GLOBALS__ = globals;
        globalWindow.__STORYBOOK_GLOBALS__ = { ...(globalWindow.__STORYBOOK_GLOBALS__ ?? {}), ...globals };
        document.documentElement.dataset.chromaSnapMode = modeName;
        if (theme) {
          document.documentElement.dataset.chromaSnapTheme = theme;
        }
        if (colorScheme) {
          document.documentElement.style.colorScheme = colorScheme;
          let meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"][data-chroma-snap="true"]');
          if (!meta) {
            meta = document.createElement("meta");
            meta.name = "color-scheme";
            meta.dataset.chromaSnap = "true";
            document.head.appendChild(meta);
          }
          meta.content = colorScheme;
        }
        globalWindow.__STORYBOOK_ADDONS_CHANNEL__?.emit?.("updateGlobals", { globals });
        window.dispatchEvent(new CustomEvent("chroma-snap:mode", { detail: globalWindow.__CHROMA_SNAP_MODE__ }));
        window.dispatchEvent(new CustomEvent("chroma-snap:globals-changed", { detail: { globals } }));
      },
      {
        modeName: mode.name,
        viewport: mode.viewport,
        colorScheme: mode.colorScheme,
        theme: mode.theme,
        globals: mode.globals ?? {},
      },
    );
  }
}

async function preparePage(page: unknown, options: VitestAutoCaptureOptions, mode: SnapshotModeMetadata): Promise<void> {
  const maybePage = page as BrowserPageLike | undefined;
  if (typeof maybePage?.evaluate !== "function") {
    return;
  }

  await maybePage.evaluate(
    async ({ waitForFonts, pauseAnimations, modeName }) => {
      if (pauseAnimations) {
        let style = document.getElementById("chroma-snap-disable-animations") as HTMLStyleElement | null;
        if (!style) {
          style = document.createElement("style");
          style.id = "chroma-snap-disable-animations";
          document.head.appendChild(style);
        }
        style.textContent = `*, *::before, *::after { animation-delay: 0s !important; animation-duration: 0s !important; animation-play-state: paused !important; transition-delay: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }`;
      }
      document.documentElement.dataset.chromaSnapMode = modeName;
      if (waitForFonts && "fonts" in document) {
        await (document as Document & { fonts: { ready: Promise<unknown> } }).fonts.ready;
      }
    },
    { waitForFonts: options.waitForFonts ?? true, pauseAnimations: options.pauseAnimations ?? true, modeName: mode.name },
  );
}

async function takeScreenshot(page: unknown, timeoutMs: number): Promise<Uint8Array> {
  const maybePage = page as BrowserPageLike | undefined;
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
  baseEvent: CaptureEventBase,
  options: VitestAutoCaptureOptions,
  timings: CaptureTimings,
): Promise<SnapshotCaptureEvent> {
  const event: SnapshotCaptureEvent = {
    ...baseEvent,
    type: "snapshot",
    imageBase64: Buffer.from(screenshot).toString("base64"),
    imageSha256: sha256(screenshot),
    timings,
  };

  if (options.outputDir) {
    const fileName = buildSnapshotFileName(baseEvent);
    const imagePath = resolve(options.outputDir, fileName);
    await mkdir(dirname(imagePath), { recursive: true });
    await writeFile(imagePath, screenshot);
    event.imagePath = imagePath;
    delete event.imageBase64;
  }

  return event;
}

export function buildSnapshotFileName(event: Pick<CaptureEventBase, "capturedAt" | "story" | "mode">): string {
  const storySegment = safeFileSegment(event.story.id, 120);
  const modeSegment = safeFileSegment(event.mode.name, 80);
  const suffix = hashObject({ capturedAt: event.capturedAt, storyId: event.story.id, mode: event.mode, pid: process.pid }).slice(0, 10);
  return `${storySegment}__${modeSegment}__${suffix}.png`;
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

export function safeFileSegment(value: string, maxLength = 120): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "snapshot";
  return sanitized.length > maxLength ? sanitized.slice(0, maxLength).replace(/[.-]+$/g, "") || "snapshot" : sanitized;
}

export function serializeError(error: unknown, timeoutMs?: number): CaptureError {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: string };
    const timeoutLike = error.name === "TimeoutError" || /\btimeout\b/i.test(error.message);
    return {
      message: error.message,
      stack: error.stack,
      code: withCode.code,
      timeoutMs: timeoutLike ? timeoutMs : undefined,
    };
  }
  return { message: String(error) };
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

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolveDelay) => setTimeout(resolveDelay, ms)) : Promise.resolve();
}

export type { BrowserName, ColorScheme, ViewportConfig };
