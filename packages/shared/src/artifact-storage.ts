import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { sha256 } from "./hash.js";

export interface StoredArtifactMetadata {
  objectKey: string;
  sha256: string;
  byteSize: number;
}

export interface ArtifactVerificationResult {
  exists: boolean;
  objectKey: string;
  sha256?: string;
  byteSize?: number;
  integrityOk?: boolean;
  error?: string;
}

export interface ArtifactStore {
  putArtifact(objectKey: string, bytes: Uint8Array): Promise<StoredArtifactMetadata>;
  readArtifact(objectKey: string): Promise<Uint8Array>;
  verifyArtifact(objectKey: string, expected?: { sha256?: string; byteSize?: number }): Promise<ArtifactVerificationResult>;
  deleteArtifacts(objectKeys: string[]): Promise<void>;
  localPath?(objectKey: string): string;
}

export class FileArtifactStore implements ArtifactStore {
  private readonly rootDir: string;

  constructor(storageDir: string) {
    this.rootDir = resolve(storageDir);
  }

  async putArtifact(objectKey: string, bytes: Uint8Array): Promise<StoredArtifactMetadata> {
    const path = this.resolveObjectPath(objectKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return {
      objectKey,
      sha256: sha256(bytes),
      byteSize: bytes.byteLength,
    };
  }

  async readArtifact(objectKey: string): Promise<Uint8Array> {
    return readFile(this.resolveObjectPath(objectKey));
  }

  async verifyArtifact(objectKey: string, expected: { sha256?: string; byteSize?: number } = {}): Promise<ArtifactVerificationResult> {
    try {
      const path = this.resolveObjectPath(objectKey);
      const fileStat = await stat(path);
      const actualSha256 = await sha256Path(path);
      const actualByteSize = fileStat.size;
      const hashOk = expected.sha256 === undefined || expected.sha256 === actualSha256;
      const sizeOk = expected.byteSize === undefined || expected.byteSize === actualByteSize;
      return {
        exists: true,
        objectKey,
        sha256: actualSha256,
        byteSize: actualByteSize,
        integrityOk: hashOk && sizeOk,
        error: hashOk && sizeOk ? undefined : integrityError(expected, { sha256: actualSha256, byteSize: actualByteSize }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false, objectKey, integrityOk: false, error: "Artifact does not exist." };
      }
      throw error;
    }
  }

  async deleteArtifacts(objectKeys: string[]): Promise<void> {
    await Promise.all(objectKeys.map((objectKey) => rm(this.resolveObjectPath(objectKey), { force: true })));
  }

  localPath(objectKey: string): string {
    return this.resolveObjectPath(objectKey);
  }

  private resolveObjectPath(objectKey: string): string {
    if (!objectKey || objectKey.includes("\0")) {
      throw new Error("Artifact objectKey must be a non-empty safe path.");
    }
    const resolved = resolve(this.rootDir, objectKey);
    if (resolved !== this.rootDir && !resolved.startsWith(`${this.rootDir}${sep}`)) {
      throw new Error(`Artifact objectKey '${objectKey}' escapes the storage root.`);
    }
    return resolved;
  }
}

async function sha256Path(path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return sha256(Buffer.concat(chunks));
}

function integrityError(expected: { sha256?: string; byteSize?: number }, actual: { sha256: string; byteSize: number }): string {
  const errors: string[] = [];
  if (expected.sha256 !== undefined && expected.sha256 !== actual.sha256) {
    errors.push(`sha256 mismatch: expected ${expected.sha256}, got ${actual.sha256}`);
  }
  if (expected.byteSize !== undefined && expected.byteSize !== actual.byteSize) {
    errors.push(`size mismatch: expected ${expected.byteSize}, got ${actual.byteSize}`);
  }
  return errors.join("; ");
}
