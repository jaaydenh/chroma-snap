export * from "./queue-processor.js";
export * from "./api-stores.js";
export * from "./diff.js";
export * from "./processor.js";

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { FileComparisonStore, FileReviewStore } from "@chroma-snap/shared";
import { processManifestFile } from "./processor.js";

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const manifest = stringArg(args, "manifest") ?? args._[0];
  if (!manifest) {
    throw new Error("Usage: chroma-snap-worker --manifest <manifest.json> [--baseline-file .chroma-snap/baselines.json] [--comparison-file .chroma-snap/comparisons.json] [--review-file .chroma-snap/reviews.json] [--output-dir .chroma-snap/report] [--seed-baselines] [--reconcile-approved]");
  }

  const reconcileApprovedBaselines = Boolean(args["reconcile-approved"]);
  const comparisonFile = stringArg(args, "comparison-file") ?? ".chroma-snap/comparisons.json";
  const reviewFile = stringArg(args, "review-file") ?? ".chroma-snap/reviews.json";
  const report = await processManifestFile(resolve(manifest), {
    baselineFile: resolve(stringArg(args, "baseline-file") ?? ".chroma-snap/baselines.json"),
    comparisonStore: reconcileApprovedBaselines ? new FileComparisonStore(resolve(comparisonFile)) : undefined,
    reviewStore: reconcileApprovedBaselines ? new FileReviewStore(resolve(reviewFile)) : undefined,
    outputDir: resolve(stringArg(args, "output-dir") ?? ".chroma-snap/report"),
    seedBaselines: Boolean(args["seed-baselines"]),
    reconcileApprovedBaselines,
  });
  console.log(JSON.stringify({ buildId: report.buildId, conclusion: report.checkConclusion, summary: report.summary }, null, 2));
}

function parseArgs(argv: string[]): Record<string, string | boolean | string[]> & { _: string[] } {
  const out: Record<string, string | boolean | string[]> & { _: string[] } = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token?.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        index += 1;
      }
    } else if (token) {
      out._.push(token);
    }
  }
  return out;
}

function stringArg(args: Record<string, string | boolean | string[]> & { _: string[] }, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
