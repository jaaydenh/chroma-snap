export * from "./github-app.js";
export * from "./github-store.js";
export * from "./session.js";
export * from "./upload-integrity.js";
export * from "./oidc.js";
export * from "./server.js";

import { pathToFileURL } from "node:url";
import type { PrivateBetaLimits } from "@chroma-snap/shared";
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
    adminSecret: process.env.CHROMA_SNAP_ADMIN_SECRET,
    privateBetaLimits: privateBetaLimitsFromEnv(process.env),
    enableRequestLogging: process.env.CHROMA_SNAP_REQUEST_LOGS === "1",
    githubCheckPublisher,
  });
  console.log(`Chroma Snap API listening on ${url}`);
}

function privateBetaLimitsFromEnv(env: NodeJS.ProcessEnv): PrivateBetaLimits | false | undefined {
  if (env.CHROMA_SNAP_PRIVATE_BETA_LIMITS === "0" || env.CHROMA_SNAP_PRIVATE_BETA_LIMITS === "false") {
    return false;
  }
  const limits: PrivateBetaLimits = {};
  setNumber(limits, "maxArtifactsPerUploadSession", env.CHROMA_SNAP_MAX_ARTIFACTS_PER_UPLOAD_SESSION);
  setNumber(limits, "maxArtifactBytesPerUploadSession", env.CHROMA_SNAP_MAX_ARTIFACT_BYTES_PER_UPLOAD_SESSION);
  setNumber(limits, "maxSnapshotsPerBuild", env.CHROMA_SNAP_MAX_SNAPSHOTS_PER_BUILD);
  setNumber(limits, "maxSnapshotBytesPerBuild", env.CHROMA_SNAP_MAX_SNAPSHOT_BYTES_PER_BUILD);
  setNumber(limits, "maxErroredSnapshotsPerBuild", env.CHROMA_SNAP_MAX_ERRORED_SNAPSHOTS_PER_BUILD);
  if (env.CHROMA_SNAP_REPOSITORY_ALLOWLIST) {
    limits.allowlistedRepositories = csv(env.CHROMA_SNAP_REPOSITORY_ALLOWLIST);
  }
  if (env.CHROMA_SNAP_REPOSITORY_BLOCKLIST) {
    limits.blockedRepositories = csv(env.CHROMA_SNAP_REPOSITORY_BLOCKLIST);
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function setNumber<T extends keyof PrivateBetaLimits>(limits: PrivateBetaLimits, key: T, value: string | undefined): void {
  if (!value) {
    return;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number.`);
  }
  (limits as Record<string, number>)[key] = parsed;
}

function csv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
