import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { DiffStats } from "@chroma-snap/shared";

export interface DiffPngOptions {
  threshold?: number;
  includeAntiAliasing?: boolean;
}

export async function diffPngFiles(currentPath: string, baselinePath: string, diffPath: string, options: DiffPngOptions = {}): Promise<DiffStats> {
  const [current, baseline] = await Promise.all([readPng(currentPath), readPng(baselinePath)]);
  const width = Math.max(current.width, baseline.width);
  const height = Math.max(current.height, baseline.height);
  const dimensionsChanged = current.width !== baseline.width || current.height !== baseline.height;
  const normalizedCurrent = normalizePngSize(current, width, height);
  const normalizedBaseline = normalizePngSize(baseline, width, height);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(
    normalizedCurrent.data,
    normalizedBaseline.data,
    diff.data,
    width,
    height,
    {
      threshold: options.threshold ?? 0.1,
      includeAA: options.includeAntiAliasing ?? false,
    },
  );

  await mkdir(dirname(diffPath), { recursive: true });
  await writeFile(diffPath, PNG.sync.write(diff));

  const totalPixels = width * height;
  return {
    width,
    height,
    diffPixels,
    totalPixels,
    diffPixelRatio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    dimensionsChanged,
  };
}

async function readPng(path: string): Promise<PNG> {
  const buffer = await readFile(path);
  return PNG.sync.read(buffer);
}

function normalizePngSize(input: PNG, width: number, height: number): PNG {
  if (input.width === width && input.height === height) {
    return input;
  }

  const out = new PNG({ width, height });
  for (let y = 0; y < input.height; y += 1) {
    const sourceStart = y * input.width * 4;
    const targetStart = y * width * 4;
    input.data.copy(out.data, targetStart, sourceStart, sourceStart + input.width * 4);
  }
  return out;
}
