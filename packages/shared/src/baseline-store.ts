import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { hashObject } from "./hash.js";
import type { BaselineRecord } from "./review.js";

export interface BaselineLookupInput {
  repositoryFullName: string;
  projectName: string;
  branch: string;
  identityKey: string;
}

export interface BaselineBranchInput {
  repositoryFullName: string;
  projectName: string;
  branch: string;
}

export interface BaselineStore {
  lookupBaseline(input: BaselineLookupInput): Promise<BaselineRecord | undefined>;
  listBaselinesForBranch(input: BaselineBranchInput): Promise<BaselineRecord[]>;
  promoteBaseline(record: BaselineRecord): Promise<void>;
  deleteBaseline(input: BaselineLookupInput): Promise<void>;
}

export interface BaselineStoreDocument {
  version: 1;
  records: Record<string, BaselineRecord>;
}

export function baselineRecordKey(input: BaselineLookupInput): string {
  return hashObject({
    repositoryFullName: input.repositoryFullName,
    projectName: input.projectName,
    branch: input.branch,
    identityKey: input.identityKey,
  });
}

export class FileBaselineStore implements BaselineStore {
  constructor(private readonly path: string) {}

  async lookupBaseline(input: BaselineLookupInput): Promise<BaselineRecord | undefined> {
    const store = await this.readStore();
    return store.records[baselineRecordKey(input)];
  }

  async listBaselinesForBranch(input: BaselineBranchInput): Promise<BaselineRecord[]> {
    const store = await this.readStore();
    return Object.values(store.records).filter(
      (record) =>
        record.repositoryFullName === input.repositoryFullName &&
        record.projectName === input.projectName &&
        record.branch === input.branch,
    );
  }

  async promoteBaseline(record: BaselineRecord): Promise<void> {
    const store = await this.readStore();
    store.records[baselineRecordKey(record)] = record;
    await this.writeStore(store);
  }

  async deleteBaseline(input: BaselineLookupInput): Promise<void> {
    const store = await this.readStore();
    delete store.records[baselineRecordKey(input)];
    await this.writeStore(store);
  }

  async readStore(): Promise<BaselineStoreDocument> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as BaselineStoreDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, records: {} };
      }
      throw error;
    }
  }

  async writeStore(store: BaselineStoreDocument): Promise<void> {
    await mkdir(dirname(resolve(this.path)), { recursive: true });
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
  }
}
