#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { platform } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createVitestSetupModule, type CaptureEvent } from "@chroma-snap/capture-storybook-vitest";
import {
  assertValidConfig,
  assertValidManifest,
  configHash,
  MANIFEST_SCHEMA_VERSION,
  sha256File,
  snapshotIdentityKey,
  type BuildManifest,
  type CreateUploadSessionRequest,
  type FinalizeUploadSessionResponse,
  type NormalizedVisualConfig,
  type SnapshotManifestEntry,
  type UploadArtifactIntent,
  type UploadSessionResponse,
} from "@chroma-snap/shared";
import { loadVisualConfig } from "./config-loader.js";
import { readPngDimensions } from "./png.js";

interface ParsedArgs extends Record<string, string | boolean | string[]> {
  _: string[];
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      await initCommand(parseArgs(rest));
      break;
    case "capture":
      await captureCommand(parseArgs(rest));
      break;
    case "upload":
      await uploadCommand(parseArgs(rest));
      break;
    case "write-vitest-setup":
      await writeVitestSetupCommand(parseArgs(rest));
      break;
    case "help":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`Unknown command '${command}'. Run chroma-snap help.`);
  }
}

async function initCommand(args: ParsedArgs): Promise<void> {
  const configPath = resolve(stringArg(args, "config", "visual.config.ts"));
  const workflowPath = resolve(".github/workflows/chroma-snap.yml");
  const setupPath = resolve(".storybook/chroma-snap.vitest.setup.ts");

  await writeFileIfMissing(
    configPath,
    `import { defineConfig } from "@chroma-snap/shared";\n\nexport default defineConfig({\n  version: 1,\n  project: { name: "storybook" },\n  storybook: {\n    configDir: ".storybook",\n    testCommand: "vitest --project storybook",\n  },\n  modes: [\n    { name: "default", viewport: { width: 1280, height: 720 }, colorScheme: "light" },\n  ],\n  thresholds: { maxDiffPixels: 100, maxDiffPixelRatio: 0.001 },\n});\n`,
  );

  await writeFileIfMissing(
    setupPath,
    `import { installVitestAutoCapture } from "@chroma-snap/capture-storybook-vitest";\n\nconst modeRaw = process.env.CHROMA_SNAP_MODE ?? '{"name":"default","viewport":{"width":1280,"height":720,"deviceScaleFactor":1},"colorScheme":"light","globals":{}}';\nlet mode;\ntry {\n  mode = JSON.parse(modeRaw);\n} catch (error) {\n  throw new Error(\`Invalid CHROMA_SNAP_MODE JSON: \${error instanceof Error ? error.message : String(error)}\`);\n}\n\nawait installVitestAutoCapture({\n  outputDir: process.env.CHROMA_SNAP_CAPTURE_OUTPUT_DIR,\n  eventsFile: process.env.CHROMA_SNAP_CAPTURE_EVENTS,\n  mode,\n  waitForFonts: true,\n  pauseAnimations: true,\n  settleDelayMs: Number(process.env.CHROMA_SNAP_SETTLE_DELAY_MS ?? 0),\n});\n`,
  );

  await writeFileIfMissing(
    workflowPath,
    `name: Chroma Snap\n\non:\n  pull_request:\n  push:\n    branches: [main]\n\npermissions:\n  contents: read\n  id-token: write\n  checks: write\n  pull-requests: read\n\njobs:\n  visual:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: npm\n      - run: npm ci\n      - run: npm run build --if-present\n      - name: Capture visual snapshots\n        run: npx chroma-snap capture --config ${relative(process.cwd(), configPath) || basename(configPath)}\n      - name: Upload visual snapshots\n        run: npx chroma-snap upload --manifest .chroma-snap/capture/manifest.json\n        env:\n          CHROMA_SNAP_SERVICE_URL: \${{ vars.CHROMA_SNAP_SERVICE_URL }}\n`,
  );

  console.log(`Initialized ${relative(process.cwd(), configPath)}, ${relative(process.cwd(), setupPath)}, and ${relative(process.cwd(), workflowPath)}.`);
}

async function captureCommand(args: ParsedArgs): Promise<void> {
  const { path: configPath, config } = await loadVisualConfig(stringArgOrUndefined(args, "config"));
  const normalized = assertValidConfig(config);
  const hash = configHash(normalized);
  const outputDir = resolve(stringArg(args, "output-dir", normalized.capture.outputDir));
  const eventsFile = resolve(stringArg(args, "events", normalized.capture.resultsFile));
  const manifestPath = resolve(stringArg(args, "manifest", `${outputDir}/manifest.json`));
  const shouldRun = !booleanArg(args, "no-run") && Boolean(normalized.storybook.testCommand);

  await mkdir(outputDir, { recursive: true });
  if (shouldRun) {
    await rm(eventsFile, { force: true });
  }

  if (shouldRun && normalized.storybook.testCommand) {
    for (const mode of normalized.modes) {
      console.log(`Running Storybook Vitest capture for mode '${mode.name}'...`);
      const result = spawnSync(normalized.storybook.testCommand, {
        shell: true,
        stdio: "inherit",
        env: {
          ...process.env,
          CHROMA_SNAP_CAPTURE_OUTPUT_DIR: outputDir,
          CHROMA_SNAP_CAPTURE_EVENTS: eventsFile,
          CHROMA_SNAP_SETTLE_DELAY_MS: String(normalized.capture.settleDelayMs),
          CHROMA_SNAP_MODE: JSON.stringify(mode),
        },
      });
      if (result.status !== 0) {
        throw new Error(`Capture command failed for mode '${mode.name}' with exit code ${result.status ?? "unknown"}.`);
      }
    }
  } else {
    console.log("Skipping Storybook test command. Use --no-run intentionally for manifest-only validation, or set storybook.testCommand.");
  }

  const events = await readCaptureEvents(eventsFile);
  const manifest = await buildManifestFromEvents(events, normalized, hash, outputDir, manifestPath, configPath);
  assertValidManifest(manifest);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const captured = manifest.snapshots.filter((snapshot) => snapshot.status === "captured").length;
  const errored = manifest.snapshots.filter((snapshot) => snapshot.status === "errored").length;
  const bytes = manifest.snapshots.reduce((sum, snapshot) => sum + (snapshot.image?.byteSize ?? 0), 0);
  console.log(`Wrote ${manifest.snapshots.length} snapshots (${captured} captured, ${errored} errored, ${bytes} bytes) to ${manifestPath}.`);
}

async function uploadCommand(args: ParsedArgs): Promise<void> {
  const manifestPath = resolve(stringArg(args, "manifest", ".chroma-snap/capture/manifest.json"));
  const serviceUrl = stringArg(args, "service-url", process.env.CHROMA_SNAP_SERVICE_URL ?? "http://127.0.0.1:4007").replace(/\/$/, "");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BuildManifest;
  assertValidManifest(manifest);

  const artifacts = await collectUploadArtifacts(manifest, dirname(manifestPath));
  const request: CreateUploadSessionRequest = {
    repository: manifest.repository,
    git: manifest.git,
    project: manifest.project,
    github: manifest.github,
    configHash: manifest.configHash,
    artifacts: artifacts.map(({ filePath: _filePath, ...artifact }) => artifact),
  };

  const authHeader = await buildAuthHeader(stringArgOrUndefined(args, "audience"));
  const sessionResponse = await postJson<UploadSessionResponse>(`${serviceUrl}/v1/upload-sessions`, request, authHeader);
  const targetsById = new Map(sessionResponse.uploadTargets.map((target) => [target.artifactId, target]));

  for (const artifact of artifacts) {
    const target = targetsById.get(artifact.id);
    if (!target) {
      throw new Error(`Upload session did not return a target for artifact '${artifact.id}'.`);
    }
    const bytes = await readFile(artifact.filePath);
    const response = await fetch(target.url, {
      method: target.method,
      headers: target.headers,
      body: bytes,
    });
    if (!response.ok) {
      throw new Error(`Failed to upload ${artifact.fileName}: HTTP ${response.status} ${await response.text()}`);
    }
    applyObjectKey(manifest, artifact.id, target.objectKey);
  }

  const finalize = await postJson<FinalizeUploadSessionResponse>(`${serviceUrl}/v1/upload-sessions/${sessionResponse.sessionId}/finalize`, { manifest }, authHeader);
  console.log(`Upload finalized for build ${finalize.buildId}. Report: ${finalize.reportUrl ?? "pending"}`);
}

async function writeVitestSetupCommand(args: ParsedArgs): Promise<void> {
  const { config } = await loadVisualConfig(stringArgOrUndefined(args, "config"));
  const normalized = assertValidConfig(config);
  const out = resolve(stringArg(args, "out", ".storybook/chroma-snap.vitest.setup.ts"));
  const source = createVitestSetupModule({
    outputDir: process.env.CHROMA_SNAP_CAPTURE_OUTPUT_DIR ?? normalized.capture.outputDir,
    eventsFile: process.env.CHROMA_SNAP_CAPTURE_EVENTS ?? normalized.capture.resultsFile,
    mode: normalized.modes[0],
    waitForFonts: normalized.capture.waitForFonts,
    pauseAnimations: normalized.capture.pauseAnimations,
    settleDelayMs: normalized.capture.settleDelayMs,
    timeoutMs: normalized.capture.timeoutMs,
  });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, source, "utf8");
  console.log(`Wrote Vitest setup module to ${out}.`);
}

async function buildManifestFromEvents(
  events: CaptureEvent[],
  config: NormalizedVisualConfig,
  hash: string,
  outputDir: string,
  manifestPath: string,
  configPath: string,
): Promise<BuildManifest> {
  const repository = repositoryContext();
  const git = gitContext();
  const snapshots: SnapshotManifestEntry[] = [];
  const manifestDir = dirname(manifestPath);

  for (const event of events) {
    const identityKey = snapshotIdentityKey({
      repositoryFullName: repository.fullName,
      projectName: config.project.name,
      storyId: event.story.id,
      browserName: event.browser.name,
      modeName: event.mode.name,
      viewport: event.mode.viewport,
      theme: event.mode.theme,
      globals: event.mode.globals,
      configHash: hash,
    });

    if (event.type === "error") {
      snapshots.push({
        identityKey,
        story: event.story,
        mode: event.mode,
        browser: event.browser,
        status: "errored",
        error: event.error,
        thresholds: config.thresholds,
        timings: event.timings,
      });
      continue;
    }

    let imagePath = event.imagePath ? resolve(event.imagePath) : undefined;
    if (!imagePath && event.imageBase64) {
      imagePath = resolve(outputDir, `${event.story.id}__${event.mode.name}.png`);
      await mkdir(dirname(imagePath), { recursive: true });
      await writeFile(imagePath, Buffer.from(event.imageBase64, "base64"));
    }
    if (!imagePath) {
      throw new Error(`Snapshot event for '${event.story.id}' did not include imagePath or imageBase64.`);
    }

    const imageStat = await stat(imagePath);
    const dimensions = await readPngDimensions(imagePath);
    snapshots.push({
      identityKey,
      story: event.story,
      mode: event.mode,
      browser: event.browser,
      status: "captured",
      image: {
        path: relative(manifestDir, imagePath) || basename(imagePath),
        sha256: await sha256File(imagePath),
        byteSize: imageStat.size,
        width: dimensions?.width,
        height: dimensions?.height,
        contentType: "image/png",
      },
      thresholds: config.thresholds,
      timings: event.timings,
    });
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    manifestId: randomUUID(),
    generatedAt: new Date().toISOString(),
    project: config.project,
    repository,
    git,
    github: githubRunContext(),
    configHash: hash,
    capture: {
      adapter: process.env.CHROMA_SNAP_ADAPTER ?? "storybook-vitest-browser",
      environment: {
        os: platform(),
        nodeVersion: process.version,
        adapterPackageVersion: "0.1.0",
      },
      thresholds: config.thresholds,
      masks: config.masks,
    },
    snapshots,
  };
}

async function readCaptureEvents(path: string): Promise<CaptureEvent[]> {
  try {
    const content = await readFile(path, "utf8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, index) => {
        try {
          return JSON.parse(line) as CaptureEvent;
        } catch (error) {
          throw new Error(`Invalid JSON in capture event line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

interface UploadArtifactWithPath extends UploadArtifactIntent {
  filePath: string;
}

async function collectUploadArtifacts(manifest: BuildManifest, manifestDir: string): Promise<UploadArtifactWithPath[]> {
  const artifacts: UploadArtifactWithPath[] = [];
  for (const snapshot of manifest.snapshots) {
    if (snapshot.status !== "captured" || !snapshot.image?.path) {
      continue;
    }
    artifacts.push({
      id: `${snapshot.identityKey}.png`,
      kind: "screenshot",
      fileName: basename(snapshot.image.path),
      contentType: snapshot.image.contentType ?? "image/png",
      sha256: snapshot.image.sha256,
      byteSize: snapshot.image.byteSize,
      filePath: resolve(manifestDir, snapshot.image.path),
    });
  }
  return artifacts;
}

function applyObjectKey(manifest: BuildManifest, artifactId: string, objectKey: string): void {
  const identityKey = artifactId.replace(/\.png$/, "");
  const snapshot = manifest.snapshots.find((entry) => entry.identityKey === identityKey);
  if (snapshot?.image) {
    snapshot.image.objectKey = objectKey;
  }
}

async function buildAuthHeader(audience?: string): Promise<Record<string, string>> {
  const explicit = process.env.CHROMA_SNAP_OIDC_TOKEN;
  if (explicit) {
    return { authorization: `Bearer ${explicit}` };
  }

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (requestUrl && requestToken) {
    const url = new URL(requestUrl);
    if (audience) {
      url.searchParams.set("audience", audience);
    }
    const response = await fetch(url, { headers: { authorization: `Bearer ${requestToken}` } });
    if (!response.ok) {
      throw new Error(`Failed to fetch GitHub Actions OIDC token: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { value?: string };
    if (!body.value) {
      throw new Error("GitHub Actions OIDC response did not include a token value.");
    }
    return { authorization: `Bearer ${body.value}` };
  }

  return {};
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function repositoryContext(): BuildManifest["repository"] {
  const fullName = process.env.GITHUB_REPOSITORY ?? "local/local";
  const [owner = "local", name = "local"] = fullName.split("/");
  return {
    provider: "github",
    owner,
    name,
    fullName: `${owner}/${name}`,
    installationId: process.env.CHROMA_SNAP_GITHUB_INSTALLATION_ID,
  };
}

function gitContext(): BuildManifest["git"] {
  const prNumber = process.env.GITHUB_EVENT_NAME === "pull_request" ? Number(process.env.GITHUB_REF_NAME?.split("/").pop()) : undefined;
  return {
    commitSha: process.env.GITHUB_SHA ?? gitOutput(["rev-parse", "HEAD"]) ?? "unknown",
    branch: process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown",
    baseBranch: process.env.GITHUB_BASE_REF || process.env.CHROMA_SNAP_BASE_BRANCH || undefined,
    mergeBaseSha: process.env.CHROMA_SNAP_MERGE_BASE_SHA,
    pullRequestNumber: Number.isFinite(prNumber) ? prNumber : undefined,
  };
}

function githubRunContext(): BuildManifest["github"] {
  return {
    workflow: process.env.GITHUB_WORKFLOW,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    job: process.env.GITHUB_JOB,
    actor: process.env.GITHUB_ACTOR,
    eventName: process.env.GITHUB_EVENT_NAME,
    serverUrl: process.env.GITHUB_SERVER_URL,
  };
}

function gitOutput(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

async function writeFileIfMissing(path: string, content: string): Promise<void> {
  try {
    await stat(path);
    console.log(`Keeping existing ${path}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    console.log(`Wrote ${path}.`);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = rawKey!;
      if (inlineValue !== undefined) {
        out[key] = inlineValue;
        continue;
      }
      if (key.startsWith("no-")) {
        out[key] = true;
        continue;
      }
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        index += 1;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

function stringArg(args: ParsedArgs, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function stringArgOrUndefined(args: ParsedArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function booleanArg(args: ParsedArgs, key: string): boolean {
  return args[key] === true;
}

function printHelp(): void {
  console.log(`Chroma Snap\n\nCommands:\n  init                         Create visual.config.ts, Vitest setup, and GitHub Actions example\n  capture [--config path]      Run Storybook/Vitest capture and write a normalized manifest\n  upload [--manifest path]     Upload screenshots and finalize a build session\n  write-vitest-setup           Write the experimental Vitest afterEach screenshot setup\n\nCommon flags:\n  --no-run                     Build a manifest from existing capture events without running tests\n  --output-dir <dir>           Capture output directory\n  --service-url <url>          API URL for upload\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

export { main };
