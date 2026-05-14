import { hashObject } from "./hash.js";
import type { ColorScheme, ThresholdConfig, ViewportConfig } from "./config.js";

export const MANIFEST_SCHEMA_VERSION = 1 as const;

export interface RepositoryContext {
  provider: "github";
  owner: string;
  name: string;
  fullName: string;
  installationId?: string;
}

export interface GitContext {
  commitSha: string;
  branch: string;
  baseBranch?: string;
  mergeBaseSha?: string;
  pullRequestNumber?: number;
}

export interface GitHubRunContext {
  workflow?: string;
  runId?: string;
  runAttempt?: string;
  job?: string;
  actor?: string;
  eventName?: string;
  serverUrl?: string;
}

export interface CaptureEnvironment {
  os?: string;
  nodeVersion?: string;
  storybookVersion?: string;
  vitestVersion?: string;
  playwrightVersion?: string;
  chromiumVersion?: string;
  adapterPackageVersion?: string;
}

export interface StoryMetadata {
  id: string;
  title?: string;
  name?: string;
  exportName?: string;
  importPath?: string;
  componentName?: string;
  tags?: string[];
}

export interface SnapshotModeMetadata {
  name: string;
  viewport: ViewportConfig;
  colorScheme?: ColorScheme;
  theme?: string;
  globals?: Record<string, string | number | boolean | null>;
}

export interface BrowserMetadata {
  name: "chromium";
  version?: string;
}

export interface ImageArtifact {
  path?: string;
  objectKey?: string;
  sha256: string;
  byteSize?: number;
  width?: number;
  height?: number;
  contentType?: "image/png";
}

export interface LogArtifact {
  path?: string;
  objectKey?: string;
  sha256?: string;
  byteSize?: number;
  contentType?: "text/plain" | "application/json";
}

export interface CaptureError {
  message: string;
  stack?: string;
  code?: string;
  timeoutMs?: number;
  logExcerpt?: string;
}

export interface SnapshotIdentityInput {
  repositoryFullName: string;
  projectName: string;
  storyId: string;
  browserName: string;
  modeName: string;
  viewport: ViewportConfig;
  theme?: string;
  globals?: Record<string, string | number | boolean | null>;
  configHash: string;
}

export interface SnapshotManifestEntry {
  identityKey: string;
  story: StoryMetadata;
  mode: SnapshotModeMetadata;
  browser: BrowserMetadata;
  status: "captured" | "errored";
  image?: ImageArtifact;
  error?: CaptureError;
  logs?: LogArtifact;
  thresholds?: ThresholdConfig;
  timings?: {
    renderMs?: number;
    playMs?: number;
    prepareMs?: number;
    captureMs?: number;
    totalMs?: number;
  };
}

export interface BuildManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  manifestId: string;
  generatedAt: string;
  project: {
    name: string;
    slug?: string;
  };
  repository: RepositoryContext;
  git: GitContext;
  github?: GitHubRunContext;
  configHash: string;
  capture: {
    adapter: "storybook-vitest-browser" | "fixture" | string;
    environment: CaptureEnvironment;
    thresholds: Required<ThresholdConfig>;
    masks: Array<{ selector?: string; rect?: { x: number; y: number; width: number; height: number }; reason?: string }>;
  };
  snapshots: SnapshotManifestEntry[];
}

export function snapshotIdentityKey(input: SnapshotIdentityInput): string {
  return hashObject({
    repositoryFullName: input.repositoryFullName,
    projectName: input.projectName,
    storyId: input.storyId,
    browserName: input.browserName,
    modeName: input.modeName,
    viewport: input.viewport,
    theme: input.theme,
    globals: input.globals ?? {},
    configHash: input.configHash,
  }).slice(0, 40);
}

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateManifest(manifest: BuildManifest): ManifestValidationResult {
  const errors: string[] = [];
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`Unsupported manifest schemaVersion ${manifest.schemaVersion}; expected ${MANIFEST_SCHEMA_VERSION}.`);
  }
  if (!manifest.manifestId) {
    errors.push("manifestId is required.");
  }
  if (!manifest.project?.name) {
    errors.push("project.name is required.");
  }
  if (!manifest.repository?.fullName) {
    errors.push("repository.fullName is required.");
  }
  if (!manifest.git?.commitSha) {
    errors.push("git.commitSha is required.");
  }
  if (!manifest.git?.branch) {
    errors.push("git.branch is required.");
  }
  if (!manifest.configHash) {
    errors.push("configHash is required.");
  }

  const identities = new Set<string>();
  for (const [index, snapshot] of manifest.snapshots.entries()) {
    if (!snapshot.identityKey) {
      errors.push(`snapshots[${index}].identityKey is required.`);
    } else if (identities.has(snapshot.identityKey)) {
      errors.push(`Duplicate snapshot identityKey '${snapshot.identityKey}'.`);
    }
    identities.add(snapshot.identityKey);
    if (!snapshot.story?.id) {
      errors.push(`snapshots[${index}].story.id is required.`);
    }
    if (!snapshot.mode?.name) {
      errors.push(`snapshots[${index}].mode.name is required.`);
    }
    if (snapshot.browser?.name !== "chromium") {
      errors.push(`snapshots[${index}].browser.name must be chromium for v1.`);
    }
    if (snapshot.status === "captured") {
      if (!snapshot.image?.sha256) {
        errors.push(`snapshots[${index}] is captured but image.sha256 is missing.`);
      }
    } else if (snapshot.status === "errored") {
      if (!snapshot.error?.message) {
        errors.push(`snapshots[${index}] is errored but error.message is missing.`);
      }
    } else {
      errors.push(`snapshots[${index}].status '${(snapshot as { status?: string }).status}' is unsupported.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidManifest(manifest: BuildManifest): BuildManifest {
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    throw new Error(`Invalid build manifest:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`);
  }
  return manifest;
}
