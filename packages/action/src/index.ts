import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "../../cli/dist/index.js");

function input(name: string, fallback?: string): string | undefined {
  const key = `INPUT_${name.replace(/ /g, "_").replace(/-/g, "_").toUpperCase()}`;
  return process.env[key] || fallback;
}

function run(args: string[]): void {
  const result = spawnSync(process.execPath, [cliPath, ...args], { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const configPath = input("config-path", "visual.config.ts")!;
const manifestPath = input("manifest-path", ".chroma-snap/capture/manifest.json")!;
const serviceUrl = input("service-url") ?? process.env.CHROMA_SNAP_SERVICE_URL;
const shouldUpload = input("upload", "true") !== "false";

run(["capture", "--config", configPath, "--manifest", manifestPath]);

if (shouldUpload) {
  if (!serviceUrl) {
    console.error("Chroma Snap action requires service-url when upload=true.");
    process.exit(1);
  }
  run(["upload", "--manifest", manifestPath, "--service-url", serviceUrl]);
}
