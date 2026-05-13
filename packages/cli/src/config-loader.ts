import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { VisualConfig } from "@chroma-snap/shared";

const CONFIG_CANDIDATES = ["visual.config.ts", "visual.config.mts", "visual.config.js", "visual.config.mjs", "visual.config.json"];

export async function discoverConfigPath(cwd = process.cwd()): Promise<string> {
  for (const candidate of CONFIG_CANDIDATES) {
    const path = resolve(cwd, candidate);
    try {
      await access(path);
      return path;
    } catch {
      // Continue discovery.
    }
  }
  throw new Error(`No visual config found. Looked for ${CONFIG_CANDIDATES.join(", ")} in ${cwd}.`);
}

export async function loadVisualConfig(path?: string): Promise<{ path: string; config: VisualConfig }> {
  const resolved = path ? resolve(path) : await discoverConfigPath();
  if (resolved.endsWith(".json")) {
    return { path: resolved, config: JSON.parse(await readFile(resolved, "utf8")) as VisualConfig };
  }

  const mod = await importConfigModule(resolved);
  const config = mod.default ?? mod.config ?? (isPlainConfig(mod) ? mod : undefined);
  if (!config) {
    throw new Error(`${resolved} must export a default visual config or named config.`);
  }
  return { path: resolved, config };
}

async function importConfigModule(resolved: string): Promise<{ default?: VisualConfig; config?: VisualConfig } & Record<string, unknown>> {
  const url = pathToFileURL(resolved);
  url.searchParams.set("t", Date.now().toString());
  try {
    return (await import(url.href)) as { default?: VisualConfig; config?: VisualConfig } & Record<string, unknown>;
  } catch (nativeImportError) {
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    try {
      const loaded = (await jiti.import(resolved)) as unknown;
      if (loaded && typeof loaded === "object") {
        return loaded as { default?: VisualConfig; config?: VisualConfig } & Record<string, unknown>;
      }
      return { default: loaded as VisualConfig };
    } catch (jitiError) {
      const nativeMessage = nativeImportError instanceof Error ? nativeImportError.message : String(nativeImportError);
      const jitiMessage = jitiError instanceof Error ? jitiError.message : String(jitiError);
      throw new Error(`Failed to load config ${resolved}. Native import error: ${nativeMessage}. Jiti fallback error: ${jitiMessage}`);
    }
  }
}

function isPlainConfig(value: unknown): value is VisualConfig {
  return Boolean(value && typeof value === "object" && ("project" in value || "storybook" in value || "modes" in value));
}
