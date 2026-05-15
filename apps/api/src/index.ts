export * from "./github-app.js";
export * from "./github-store.js";
export * from "./session.js";
export * from "./upload-integrity.js";
export * from "./oidc.js";
export * from "./server.js";

import { pathToFileURL } from "node:url";
import { GitHubAppClient } from "./github-app.js";
import { startApiServer } from "./server.js";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 4007);
  const storageDir = process.env.CHROMA_SNAP_STORAGE_DIR ?? ".chroma-snap/server";
  const githubAppId = process.env.CHROMA_SNAP_GITHUB_APP_ID ? Number(process.env.CHROMA_SNAP_GITHUB_APP_ID) : undefined;
  const githubPrivateKey = process.env.CHROMA_SNAP_GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const githubCheckPublisher =
    githubAppId && githubPrivateKey
      ? new GitHubAppClient({ appId: githubAppId, privateKeyPem: githubPrivateKey, apiBaseUrl: process.env.CHROMA_SNAP_GITHUB_API_URL })
      : undefined;
  const { url } = await startApiServer({
    host: process.env.HOST ?? "127.0.0.1",
    port,
    storageDir,
    allowDevAuth: process.env.CHROMA_SNAP_DEV_AUTH === "1",
    publicUrl: process.env.CHROMA_SNAP_PUBLIC_URL,
    oidcAudience: process.env.CHROMA_SNAP_OIDC_AUDIENCE,
    githubWebhookSecret: process.env.CHROMA_SNAP_GITHUB_WEBHOOK_SECRET,
    githubCheckName: process.env.CHROMA_SNAP_GITHUB_CHECK_NAME,
    githubCheckPublisher,
  });
  console.log(`Chroma Snap API listening on ${url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
