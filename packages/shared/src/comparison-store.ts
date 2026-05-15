import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ComparisonReport, SnapshotComparison } from "./review.js";

export interface ComparisonStore {
  saveComparisonReport(report: ComparisonReport): Promise<void>;
  getComparisonReport(buildId: string): Promise<ComparisonReport | undefined>;
}

export interface ComparisonStoreDocument {
  version: 1;
  reports: Record<string, ComparisonReport>;
}

export class FileComparisonStore implements ComparisonStore {
  constructor(private readonly path: string) {}

  async saveComparisonReport(report: ComparisonReport): Promise<void> {
    const store = await this.readStore();
    store.reports[report.buildId] = report;
    await this.writeStore(store);
  }

  async getComparisonReport(buildId: string): Promise<ComparisonReport | undefined> {
    const store = await this.readStore();
    return store.reports[buildId];
  }

  async listSnapshotComparisons(buildId: string): Promise<SnapshotComparison[]> {
    return (await this.getComparisonReport(buildId))?.comparisons ?? [];
  }

  async readStore(): Promise<ComparisonStoreDocument> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as ComparisonStoreDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, reports: {} };
      }
      throw error;
    }
  }

  async writeStore(store: ComparisonStoreDocument): Promise<void> {
    await mkdir(dirname(resolve(this.path)), { recursive: true });
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
  }
}
