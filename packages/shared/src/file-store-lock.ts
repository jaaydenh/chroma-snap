import { resolve } from "node:path";

const fileStoreLocks = new Map<string, Promise<void>>();

/**
 * Serializes read-modify-write updates for the same local JSON store path within
 * this process. Atomic rename protects readers from partial writes; this lock
 * prevents concurrent writers from reading the same old document and losing one
 * another's updates.
 */
export async function withFileStoreLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = fileStoreLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const next = previous.catch(() => undefined).then(() => current);
  fileStoreLocks.set(key, next);

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (fileStoreLocks.get(key) === next) {
      fileStoreLocks.delete(key);
    }
  }
}
