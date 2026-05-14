export * from "./session.js";
export * from "./upload-integrity.js";
export * from "./oidc.js";
export * from "./server.js";

import { pathToFileURL } from "node:url";
import { startApiServer } from "./server.js";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 4007);
  const storageDir = process.env.CHROMA_SNAP_STORAGE_DIR ?? ".chroma-snap/server";
  const { url } = await startApiServer({
    host: process.env.HOST ?? "127.0.0.1",
    port,
    storageDir,
    allowDevAuth: process.env.CHROMA_SNAP_DEV_AUTH === "1",
    publicUrl: process.env.CHROMA_SNAP_PUBLIC_URL,
    oidcAudience: process.env.CHROMA_SNAP_OIDC_AUDIENCE,
  });
  console.log(`Chroma Snap API listening on ${url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
