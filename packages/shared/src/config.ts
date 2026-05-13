import { hashObject } from "./hash.js";

export const CONFIG_VERSION = 1 as const;

export type ColorScheme = "light" | "dark" | "no-preference";
export type BrowserName = "chromium";

export interface ViewportConfig {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
}

export interface ModeConfig {
  /** Stable, human-readable mode name such as default, mobile, dark, or high-contrast. */
  name: string;
  /** V1 supports Chromium only. This remains a dimension so the manifest can evolve. */
  browser?: BrowserName;
  viewport: ViewportConfig;
  colorScheme?: ColorScheme;
  theme?: string;
  /** Storybook globals to apply before capture, for example theme or locale. */
  globals?: Record<string, string | number | boolean | null>;
}

export interface ThresholdConfig {
  /** Maximum absolute mismatched pixels before a snapshot requires review. */
  maxDiffPixels?: number;
  /** Maximum mismatched pixel ratio before a snapshot requires review. */
  maxDiffPixelRatio?: number;
  /** Forward-looking anti-aliasing knob. Pixelmatch uses includeAA=false by default. */
  includeAntiAliasing?: boolean;
}

export interface RectMask {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MaskConfig {
  selector?: string;
  rect?: RectMask;
  reason?: string;
}

export interface StoryFilterConfig {
  storyIds?: string[];
  tags?: string[];
  files?: string[];
}

export interface StorybookConfig {
  configDir?: string;
  viteConfig?: string;
  /** Command that runs the Storybook 10/Vite Vitest browser-mode tests. */
  testCommand?: string;
  /** Optional build command for workflows that want static Storybook artifacts too. */
  buildCommand?: string;
  /** Optional already-running Storybook URL used by future adapters. */
  url?: string;
}

export interface CaptureConfig {
  outputDir?: string;
  resultsFile?: string;
  concurrency?: number;
  timeoutMs?: number;
  pauseAnimations?: boolean;
  waitForFonts?: boolean;
}

export interface ProjectConfig {
  name?: string;
  slug?: string;
}

export interface UploadConfig {
  serviceUrl?: string;
}

export interface VisualConfig {
  version?: typeof CONFIG_VERSION;
  project?: ProjectConfig;
  storybook?: StorybookConfig;
  capture?: CaptureConfig;
  modes?: ModeConfig[];
  thresholds?: ThresholdConfig;
  masks?: MaskConfig[];
  include?: StoryFilterConfig;
  exclude?: StoryFilterConfig;
  upload?: UploadConfig;
}

export interface NormalizedVisualConfig {
  version: typeof CONFIG_VERSION;
  project: Required<Pick<ProjectConfig, "name">> & Pick<ProjectConfig, "slug">;
  storybook: Required<Pick<StorybookConfig, "configDir">> & StorybookConfig;
  capture: Required<CaptureConfig>;
  modes: Array<Required<Pick<ModeConfig, "name" | "browser" | "viewport" | "globals">> & Omit<ModeConfig, "name" | "browser" | "viewport" | "globals">>;
  thresholds: Required<ThresholdConfig>;
  masks: MaskConfig[];
  include: StoryFilterConfig;
  exclude: StoryFilterConfig;
  upload: UploadConfig;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

export function defineConfig(config: VisualConfig): VisualConfig {
  return config;
}

const DEFAULT_MODE: ModeConfig = {
  name: "default",
  browser: "chromium",
  viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  colorScheme: "light",
  globals: {},
};

export function normalizeConfig(config: VisualConfig = {}): NormalizedVisualConfig {
  const captureOutputDir = config.capture?.outputDir ?? ".chroma-snap/capture";
  return {
    version: CONFIG_VERSION,
    project: {
      name: config.project?.name ?? "default",
      ...(config.project?.slug ? { slug: config.project.slug } : {}),
    },
    storybook: {
      configDir: config.storybook?.configDir ?? ".storybook",
      ...config.storybook,
    },
    capture: {
      outputDir: captureOutputDir,
      resultsFile: config.capture?.resultsFile ?? `${captureOutputDir}/capture-events.jsonl`,
      concurrency: config.capture?.concurrency ?? 4,
      timeoutMs: config.capture?.timeoutMs ?? 30_000,
      pauseAnimations: config.capture?.pauseAnimations ?? true,
      waitForFonts: config.capture?.waitForFonts ?? true,
    },
    modes: (config.modes?.length ? config.modes : [DEFAULT_MODE]).map((mode) => ({
      ...mode,
      browser: mode.browser ?? "chromium",
      viewport: {
        deviceScaleFactor: 1,
        ...mode.viewport,
      },
      globals: mode.globals ?? {},
    })),
    thresholds: {
      maxDiffPixels: config.thresholds?.maxDiffPixels ?? 100,
      maxDiffPixelRatio: config.thresholds?.maxDiffPixelRatio ?? 0.001,
      includeAntiAliasing: config.thresholds?.includeAntiAliasing ?? false,
    },
    masks: config.masks ?? [],
    include: config.include ?? {},
    exclude: config.exclude ?? {},
    upload: config.upload ?? {},
  };
}

export function validateConfig(config: VisualConfig): ValidationResult<NormalizedVisualConfig> {
  const normalized = normalizeConfig(config);
  const errors: string[] = [];

  if (config.version !== undefined && config.version !== CONFIG_VERSION) {
    errors.push(`Unsupported config version ${config.version}; expected ${CONFIG_VERSION}.`);
  }

  if (!normalized.project.name.trim()) {
    errors.push("project.name must not be empty when provided.");
  }

  if (!normalized.storybook.configDir.trim()) {
    errors.push("storybook.configDir must not be empty.");
  }

  if (!Number.isInteger(normalized.capture.concurrency) || normalized.capture.concurrency < 1) {
    errors.push("capture.concurrency must be a positive integer.");
  }

  if (!Number.isInteger(normalized.capture.timeoutMs) || normalized.capture.timeoutMs < 1_000) {
    errors.push("capture.timeoutMs must be an integer of at least 1000ms.");
  }

  const seenModes = new Set<string>();
  for (const [index, mode] of normalized.modes.entries()) {
    if (!mode.name.trim()) {
      errors.push(`modes[${index}].name must not be empty.`);
    }
    if (seenModes.has(mode.name)) {
      errors.push(`Duplicate mode name '${mode.name}'.`);
    }
    seenModes.add(mode.name);
    if (mode.browser !== "chromium") {
      errors.push(`modes[${index}].browser '${mode.browser}' is unsupported; v1 supports chromium only.`);
    }
    if (!Number.isInteger(mode.viewport.width) || mode.viewport.width <= 0) {
      errors.push(`modes[${index}].viewport.width must be a positive integer.`);
    }
    if (!Number.isInteger(mode.viewport.height) || mode.viewport.height <= 0) {
      errors.push(`modes[${index}].viewport.height must be a positive integer.`);
    }
    if (mode.viewport.deviceScaleFactor !== undefined && (!Number.isFinite(mode.viewport.deviceScaleFactor) || mode.viewport.deviceScaleFactor <= 0)) {
      errors.push(`modes[${index}].viewport.deviceScaleFactor must be positive when provided.`);
    }
  }

  if (normalized.thresholds.maxDiffPixels < 0) {
    errors.push("thresholds.maxDiffPixels must be zero or greater.");
  }
  if (normalized.thresholds.maxDiffPixelRatio < 0 || normalized.thresholds.maxDiffPixelRatio > 1) {
    errors.push("thresholds.maxDiffPixelRatio must be between 0 and 1.");
  }

  for (const [index, mask] of normalized.masks.entries()) {
    if ((mask.selector ? 1 : 0) + (mask.rect ? 1 : 0) !== 1) {
      errors.push(`masks[${index}] must define exactly one of selector or rect.`);
    }
    if (mask.rect) {
      for (const key of ["x", "y", "width", "height"] as const) {
        if (!Number.isFinite(mask.rect[key])) {
          errors.push(`masks[${index}].rect.${key} must be a finite number.`);
        }
      }
      if (mask.rect.width <= 0 || mask.rect.height <= 0) {
        errors.push(`masks[${index}].rect.width and height must be positive.`);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: normalized, errors };
}

export function assertValidConfig(config: VisualConfig): NormalizedVisualConfig {
  const result = validateConfig(config);
  if (!result.ok || !result.value) {
    throw new Error(`Invalid visual config:\n${result.errors.map((error) => `- ${error}`).join("\n")}`);
  }
  return result.value;
}

export function configHash(config: VisualConfig | NormalizedVisualConfig): string {
  return hashObject(normalizeConfig(config as VisualConfig));
}
