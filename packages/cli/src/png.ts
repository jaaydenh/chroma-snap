import { readFile } from "node:fs/promises";

export interface PngDimensions {
  width: number;
  height: number;
}

export async function readPngDimensions(path: string): Promise<PngDimensions | undefined> {
  const buffer = await readFile(path);
  if (buffer.length < 24) {
    return undefined;
  }
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    return undefined;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}
